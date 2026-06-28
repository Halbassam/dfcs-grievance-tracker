/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Server entry point — pure Node.js, ZERO npm dependencies.
 *
 * Using only Node's built-in http and fs modules means there is
 * nothing to install, nothing that can fail to compile on a
 * free hosting tier, and nothing that can go out of date.
 * ================================================================
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

process.on("uncaughtException", (err) => {
  console.error("FATAL uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("FATAL unhandledRejection:", err);
});

const db = require("./db");
const { sendMail } = require("./mailer");
const scheduler = require("./scheduler");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ----------------------------------------------------------------
// Per-user login (session cookies)
//
// Each steward has their own username and password, set up by an
// admin from the Settings tab inside the app (Settings > Manage
// users). Logging in issues a signed session cookie that's checked
// on every request. This replaces the old single shared password.
//
// IMPORTANT: if no user accounts exist yet, the app falls back to
// fully OPEN access (no login wall at all) — this is intentional
// so you're never locked out of your own fresh deployment. As soon
// as you create the first user account from Settings, login becomes
// required for everyone, including you.
// ----------------------------------------------------------------

const SESSION_COOKIE_NAME = "dfcs_session";

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const out = {};
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE_NAME] || "";
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = 30 * 24 * 60 * 60; // 30 days, matches db.js SESSION_TTL_MS
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
}

/**
 * Returns the logged-in user ({username, displayName, role}) for this
 * request, or null if not logged in. If no user accounts exist at
 * all yet, returns a synthetic "open access" admin user so the app
 * keeps working normally (including creating that very first account)
 * until a real account exists.
 */
async function getCurrentUser(req) {
  const hasAnyUsers = await db.hasAnyUsers();

  if (!hasAnyUsers) {
    return { username: "", displayName: "", role: "admin", openAccess: true };
  }

  const token = getSessionTokenFromRequest(req);
  return db.getSessionUser(token); // null if invalid/expired/missing
}

/**
 * True if the given current-user object has admin privileges.
 * Used to gate user management and shared-configuration routes
 * (holidays, dropdown lists, steward roster) to admins only —
 * everyday grievance/activity work stays open to every logged-in
 * steward.
 */
function isAdmin(currentUser) {
  return !!(currentUser && currentUser.role === "admin");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const MAX = 2 * 1024 * 1024; // 2MB limit
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  let fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    fullPath = path.join(PUBLIC_DIR, "index.html");
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  try {
    // ---------- Routes that must work WITHOUT being logged in ----------
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const user = await db.verifyLogin(body.username, body.password);
      if (!user) {
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }
      const token = await db.createSession(user.username);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true, user });
    }

    if (pathname === "/api/auth/session" && req.method === "GET") {
      const user = await getCurrentUser(req);
      return sendJson(res, 200, { user });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = getSessionTokenFromRequest(req);
      if (token) await db.destroySession(token);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- Static frontend always loads — login state is handled client-side ----------
    if (!pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }

    // ---------- Everything else requires a valid session ----------
    // (unless no user accounts exist yet at all — see getCurrentUser)
    const currentUser = await getCurrentUser(req);
    if (!currentUser) {
      return sendJson(res, 401, { error: "Not logged in." });
    }

    if (pathname === "/api/data" && req.method === "GET") {
      const data = await db.getAll();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (pathname === "/api/grievance" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser = currentUser.displayName || currentUser.username || "";
      const result = await db.submitGrievance(body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === "/api/activity" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser = currentUser.displayName || currentUser.username || "";
      const result = await db.logActivity(body);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/archive" && req.method === "POST") {
      const result = await db.archiveClosed();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === "/api/setup/stewards" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can manage the steward roster." });
      const body = await readBody(req);
      const result = await db.updateStewards(body.stewards, body.emails);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/setup/list" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can edit dropdown lists." });
      const body = await readBody(req);
      const result = await db.updateSetupList(body.key, body.items);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/holidays" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can edit the holiday calendar." });
      const body = await readBody(req);
      const result = await db.updateHolidays(body.holidays);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/email/run-now" && req.method === "POST") {
      const summary = await scheduler.runDeadlineCheck();
      return sendJson(res, 200, summary);
    }

    if (pathname === "/api/email/status" && req.method === "GET") {
      const data = await db.getAll();
      const emailConfigured = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
      return sendJson(res, 200, {
        emailConfigured,
        lastEmailRunDate: data.lastEmailRunDate || "",
        emailLog: (data.emailLog || []).slice(0, 20)
      });
    }

    // ---------- User account management (Settings > Manage users) — admins only ----------
    if (pathname === "/api/users" && req.method === "GET") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can view user accounts." });
      return sendJson(res, 200, { users: await db.listUsersSafe() });
    }

    if (pathname === "/api/users" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can manage user accounts." });
      const body = await readBody(req);
      const result = await db.upsertUser(body);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/users/delete" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can manage user accounts." });
      const body = await readBody(req);
      // Safety: don't allow the currently logged-in user to delete
      // their own account and lock themselves out by accident.
      if (currentUser.username && body.username &&
          currentUser.username.toLowerCase() === String(body.username).toLowerCase()) {
        return sendJson(res, 400, { error: "You can't delete the account you're currently logged in as." });
      }
      const result = await db.deleteUser(body.username);
      return sendJson(res, 200, result);
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Unknown API route" });
    }

  } catch (err) {
    console.error("Request error:", err);
    return sendJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DFCS Grievance Tracker running on port ${PORT}`);
  scheduler.startScheduler();
});
