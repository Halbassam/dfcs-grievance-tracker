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

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ----------------------------------------------------------------
// Shared password protection (HTTP Basic Auth)
//
// Set APP_PASSWORD as an environment variable on Render
// (Dashboard > your service > Environment > Add Environment Variable).
// Username can be anything stewards are told (e.g. "dfcs") since
// only the password is actually checked here.
//
// If APP_PASSWORD is not set, the app falls back to NO password
// protection — this is intentional so local development never
// gets locked out by accident, but it means you MUST set
// APP_PASSWORD on Render or the site stays fully public.
// ----------------------------------------------------------------
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  if (!APP_PASSWORD) return true; // no password configured — open access

  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sepIndex = decoded.indexOf(":");
  if (sepIndex === -1) return false;

  const password = decoded.slice(sepIndex + 1);
  return timingSafeEqual(password, APP_PASSWORD);
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="DFCS Grievance Tracker", charset="UTF-8"',
    "Content-Type": "text/html; charset=utf-8"
  });
  res.end(
    "<h1>401 Unauthorized</h1><p>A valid password is required to access the DFCS Grievance Tracker.</p>"
  );
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
  if (!checkAuth(req)) {
    return sendAuthChallenge(res);
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  try {
    if (pathname === "/api/data" && req.method === "GET") {
      const data = db.getAll();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (pathname === "/api/grievance" && req.method === "POST") {
      const body = await readBody(req);
      const result = await db.submitGrievance(body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === "/api/activity" && req.method === "POST") {
      const body = await readBody(req);
      const result = await db.logActivity(body);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/archive" && req.method === "POST") {
      const result = await db.archiveClosed();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Unknown API route" });
    }

    return serveStatic(req, res, pathname);

  } catch (err) {
    console.error("Request error:", err);
    return sendJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DFCS Grievance Tracker running on port ${PORT}`);
});

