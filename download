/**
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Web server and API routes.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const scheduler = require("./scheduler");
const grievantNotify = require("./grievantNotify");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "../public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (e) { resolve({}); } });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  let fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) fullPath = path.join(PUBLIC_DIR, "index.html");

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
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

function getSessionTokenFromRequest(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/dfcs_session=([^;]+)/);
  return match ? match[1] : null;
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `dfcs_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${30*24*3600}; Path=/`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "dfcs_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/");
}

async function getCurrentUser(req) {
  const hasAnyUsers = await db.hasAnyUsers();
  if (!hasAnyUsers) return { username: "", displayName: "", role: "admin", openAccess: true };
  const token = getSessionTokenFromRequest(req);
  return db.getSessionUser(token);
}

function isAdmin(currentUser) {
  return !!(currentUser && currentUser.role === "admin");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  try {
    // Auth routes (no session required)
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const user = await db.verifyLogin(body.username, body.password);
      if (!user) return sendJson(res, 401, { error: "Incorrect username or password." });
      const token = await db.createSession(user.username);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true, user });
    }

    if (pathname === "/api/auth/session" && req.method === "GET") {
      const user = await getCurrentUser(req);
      if (!user) return sendJson(res, 401, { error: "Not logged in." });
      return sendJson(res, 200, { user });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = getSessionTokenFromRequest(req);
      if (token) await db.destroySession(token);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    // Static files
    if (!pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }

    // All other API routes require a valid session
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return sendJson(res, 401, { error: "Login required." });

    if (pathname === "/api/data" && req.method === "GET") {
      const data = await db.getAll();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/grievance" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser = currentUser.displayName || currentUser.username;
      const result = await db.submitGrievance(body);

      // Fire-and-forget: notify the grievant of any step(s) newly filed
      // in this save. This never blocks or fails the actual save, which
      // has already succeeded — a notification problem shouldn't stop a
      // steward from doing their work.
      if (result.newlyFiledSteps && (result.newlyFiledSteps.step1 || result.newlyFiledSteps.step2 || result.newlyFiledSteps.step3)) {
        grievantNotify.sendGrievantStepNotifications(result.record, result.newlyFiledSteps)
          .catch(err => console.error("[index] Unexpected error sending grievant notification:", err));
      }

      return sendJson(res, 200, result);
    }

    // Manual, steward-triggered courtesy reminder to management about a
    // Step 1 or Step 2 response deadline. Unlike grievant notifications,
    // this is synchronous — the steward needs to see whether it actually
    // sent, since it's a deliberate one-time action, not a background
    // notification.
    if (pathname === "/api/grievance/courtesy-notice" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const result = await db.sendCourtesyNotice(body.gid, body.step);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/activity" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser = currentUser.displayName || currentUser.username;
      const result = await db.logActivity(body);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/archive" && req.method === "POST") {
      const result = await db.archiveClosed();
      return sendJson(res, 200, result);
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

    if (pathname === "/api/org-settings" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can edit org settings." });
      const body = await readBody(req);
      const result = await db.updateOrgSettings(body);
      return sendJson(res, 200, result);
    }

    // User management (admin only)
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
      if (currentUser.username && body.username &&
          currentUser.username.toLowerCase() === String(body.username).toLowerCase()) {
        return sendJson(res, 400, { error: "You can't delete the account you're currently logged in as." });
      }
      const result = await db.deleteUser(body.username);
      return sendJson(res, 200, result);
    }

    // Change own password (any logged-in user)
    if (pathname === "/api/auth/change-password" && req.method === "POST") {
      const body = await readBody(req);
      const { currentPassword, newPassword } = body;
      if (!currentPassword || !newPassword)
        return sendJson(res, 400, { error: "Both the current and new passwords are required." });
      if (String(newPassword).length < 6)
        return sendJson(res, 400, { error: "New password must be at least 6 characters." });
      const verified = await db.verifyLogin(currentUser.username, currentPassword);
      if (!verified) return sendJson(res, 401, { error: "Current password is incorrect." });
      await db.upsertUser({
        username: currentUser.username,
        displayName: currentUser.displayName,
        password: newPassword
      });
      return sendJson(res, 200, { ok: true });
    }

    // Email
    if (pathname === "/api/email/status" && req.method === "GET") {
      const data = await db.getAll();
      const emailConfigured = !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
      return sendJson(res, 200, {
        emailConfigured,
        lastEmailRunDate: data.lastEmailRunDate || "",
        emailLog: (data.emailLog || []).slice(0, 20)
      });
    }

    if (pathname === "/api/email/run-now" && req.method === "POST") {
      const summary = await scheduler.runDeadlineCheck();
      return sendJson(res, 200, summary);
    }

    return sendJson(res, 404, { error: "Unknown API route" });

  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`FCRC Grievance Tracker running on port ${PORT}`);
  scheduler.startScheduler();
});
