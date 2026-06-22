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
const db = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

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

server.listen(PORT, () => {
  console.log(`DFCS Grievance Tracker running on port ${PORT}`);
});
