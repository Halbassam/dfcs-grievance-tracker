/**
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Web server and API routes.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const scheduler = require("./scheduler");
const grievantNotify = require("./grievantNotify");
const handoffNotify = require("./handoffNotify");
const grievanceDraftBot = require("./grievanceDraftBot");
const investigationForms = require("./investigationForms");
const memberForms = require("./memberForms");
const contactUpdate = require("./contactUpdate");
const newsletter = require("./newsletter");
const storage = require("./storage");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "../public");

/** Best-effort client IP — respects the X-Forwarded-For header set by Render's proxy. */
function clientIp(req) {
  // The proxy appends the address it saw, so the LAST entry is trustworthy.
  // The first entry is whatever the client sent and can be forged.
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",").pop().trim();
  return req.socket && req.socket.remoteAddress || "";
}

// ---------------------------------------------------------------------------
// Login rate limiter (in-memory)
// Tracks consecutive failures per username. After LOGIN_MAX_FAILURES attempts
// the account is locked out for LOGIN_LOCKOUT_MS. Resets on success or expiry.
// In-memory is intentional: free-tier restarts are frequent enough that a
// persistent attacker gains little, and this stops automated scripts cold.
// ---------------------------------------------------------------------------
const LOGIN_MAX_FAILURES  = 10;
const LOGIN_LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes
const _loginFailures = new Map(); // username (lowercase) → { count, lockedUntil }

// Failures are counted per username AND client address. Counting per username
// alone let one stranger lock the real steward out for 15 minutes from anywhere.
function lockKey(username, ip) {
  return `${String(username || "").trim().toLowerCase()}|${ip || ""}`;
}

function loginCheckLock(key) {
  const rec = _loginFailures.get(key);
  if (!rec) return null; // no history
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const secsLeft = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return `Too many failed login attempts. Try again in ${secsLeft} seconds.`;
  }
  return null; // either not locked or lockout has expired
}

function loginRecordFailure(key) {
  const rec = _loginFailures.get(key) || { count: 0, lockedUntil: null };
  // If a previous lockout has expired, reset the counter
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    rec.count = 0; rec.lockedUntil = null;
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
  _loginFailures.set(key, rec);
  if (_loginFailures.size > 5000) {
    const now = Date.now();
    for (const [k, r] of _loginFailures) {
      if (!r.lockedUntil || now >= r.lockedUntil) _loginFailures.delete(k);
    }
  }
}

// One "session" audit row per user per 10 minutes at most.
const SESSION_VISIT_THROTTLE_MS = 10 * 60 * 1000;
const _lastSessionVisit = new Map();
function sessionVisitShouldLog(username) {
  const now = Date.now();
  const last = _lastSessionVisit.get(username) || 0;
  if (now - last < SESSION_VISIT_THROTTLE_MS) return false;
  _lastSessionVisit.set(username, now);
  return true;
}

function loginRecordSuccess(key) {
  _loginFailures.delete(key);
}

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
    const chunks = [];
    let total = 0, tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > 1e6) {
        // Answer right away and stop buffering, rather than tearing the
        // connection down under the client before it can read the reply.
        tooLarge = true;
        return reject(httpError(413, "That request is too large."));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(httpError(400, "The request body isn't valid JSON.")); }
    });
    req.on("error", reject);
  });
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Content-Disposition with an ASCII fallback and a UTF-8 filename* so
 *  non-Latin-1 characters (e.g. an en dash from Word) can't break the header. */
function contentDisposition(filename) {
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Attachment uploads arrive as base64 JSON, which inflates ~33% over the
// raw file -- this needs a much higher ceiling than the normal 1MB body
// limit above. Kept as its own function so every other route keeps the
// tighter default.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB per file, enforced again after decoding
function readBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, tooLarge = false;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) { tooLarge = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("File is too large."));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  let fullPath = path.join(PUBLIC_DIR, filePath);
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) fullPath = path.join(PUBLIC_DIR, "index.html");

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
    `dfcs_session=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30*24*3600}; Path=/`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "dfcs_session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/");
}

async function getCurrentUser(req) {
  const hasAnyUsers = await db.hasAnyUsers();
  if (!hasAnyUsers) return { username: "", displayName: "", role: "admin", openAccess: true };
  const token = getSessionTokenFromRequest(req);
  return db.getSessionUser(token);
}

// Public contact-form submissions: at most 5 per connection every 10 minutes.
const CONTACT_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_MAX_PER_WINDOW = 5;
const _contactHits = new Map();
function contactSubmitAllowed(ip) {
  const now = Date.now();
  const recent = (_contactHits.get(ip) || []).filter(t => now - t < CONTACT_WINDOW_MS);
  if (recent.length >= CONTACT_MAX_PER_WINDOW) { _contactHits.set(ip, recent); return false; }
  recent.push(now);
  _contactHits.set(ip, recent);
  return true;
}

// Spreadsheet-safe CSV cell: values that a spreadsheet would run as a formula
// (starting with = + - @ or a tab/CR) are prefixed so they stay plain text.
function csvCellValue(val) {
  let s = val === null || val === undefined ? "" : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Admins may send to any location or the whole local. Stewards may send only to a
// location they are assigned to.
// Only admins and super stewards (steward_plus) send newsletters. Admins may send to
// any location or the whole local; a super steward only to an assigned location.
function canSendNewsletterTo(currentUser, audience, location) {
  if (!currentUser) return false;
  if (currentUser.role === "admin") return true;
  if (currentUser.role !== "steward_plus") return false;
  if (audience !== "location") return false;
  return (currentUser.locations || []).includes(String(location || "").trim());
}

// Removing entries, sending update links and revoking the link are for admins and
// super stewards. Other stewards can view, export and create the link.
function canEditMemberContacts(currentUser) {
  return !!currentUser && ["admin", "steward_plus"].includes(currentUser.role);
}

function canManageMemberContacts(currentUser) {
  return !!currentUser && ["admin", "steward_plus", "steward"].includes(currentUser.role);
}

function isAdmin(currentUser) {
  return !!(currentUser && currentUser.role === "admin");
}
function canUseBot(currentUser) {
  return !!(currentUser && (currentUser.role === "admin" || currentUser.role === "steward_plus"));
}
function userLocations(currentUser) {
  return Array.isArray(currentUser && currentUser.locations) ? currentUser.locations : [];
}
function canAccessLocation(currentUser, location) {
  if (isAdmin(currentUser)) return true;
  if (!location) return false; // no location on the record -> admin-only until backfilled
  return userLocations(currentUser).includes(location);
}

/**
 * Filters the full getAll() payload down to what this user is allowed to
 * see. Admins see everything, unfiltered. A steward/steward_plus account
 * sees only grievances/activity/archive entries whose location is one of
 * their assigned locations -- a record with NO location set (e.g. filed
 * before this feature existed) is admin-only until backfilled, which is
 * the safe default rather than showing it to everyone.
 *
 * This has to happen here, server-side, not just be hidden in the UI --
 * the whole point is that a steward's browser should never even receive
 * another location's data in the first place.
 */
function scopeDataToUser(data, currentUser) {
  if (isAdmin(currentUser)) return data;

  const locations = new Set(userLocations(currentUser));
  const grievances = data.grievances.filter(g => g.location && locations.has(g.location));
  const archive = data.archive.filter(a => a.location && locations.has(a.location));

  // Activity entries don't carry their own location -- look it up via the
  // grievance id they reference (checking both the live and archived sets,
  // since activity can reference either). Attachments are scoped the same
  // way -- a steward should never even see the filename of a file attached
  // to a grievance at a location they don't have access to.
  const visibleGids = new Set([...grievances, ...archive].map(g => g.id));
  const activity = data.activity.filter(a => visibleGids.has(a.gid));
  const attachments = (data.attachments || []).filter(a => visibleGids.has(a.gid));

  // The email log records grievant and steward addresses and grievance IDs
  // from every location, so it's admin-only rather than location-filtered.
  return { ...data, grievances, activity, archive, attachments, emailLog: [] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  try {
    // ── PUBLIC FORM ROUTES (no authentication required) ────────────────────
    // Served at /intake/:token — the mobile-friendly form sent to grievants by
    // link. (There is no witness form yet.)

    const intakeMatch = pathname.match(/^\/intake\/([a-f0-9]{48})$/);
    if (intakeMatch) {
      const token = intakeMatch[1];
      if (req.method === "GET") {
        const found = await db.getInvestigationByToken(token);
        if (!found || found.tokenRow.type !== "grievant") {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(investigationForms.errorPage({ title: "Link not found", message: "This link is not valid or has already expired." }));
        }
        if (found.isExpired) {
          res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(investigationForms.errorPage({ title: "Link expired", message: "This link has expired. Ask your steward to send a new one." }));
        }
        if (found.isUsed) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(investigationForms.errorPage({ title: "Already submitted", message: "This form has already been submitted. Contact your steward if you need to make a correction." }));
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(investigationForms.grievantIntakeForm({ investigation: found.investigation, token }));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          await db.submitInvestigationForm(token, body);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // Shared contact link, emailed to a location's employees. Not personal: the
    // link identifies only the location. Anyone with the link can enter their own
    // details, so submissions are rate-limited and a hidden field catches bots.
    const contactMatch = pathname.match(/^\/contact\/([a-f0-9]{48})$/);
    if (contactMatch) {
      const token = contactMatch[1];
      if (req.method === "GET") {
        const link = await db.getContactLink(token);
        if (!link) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(memberForms.messagePage({ title: "Link not found", message: "This link is not valid." }));
        }
        if (link.isRevoked || link.isExpired) {
          res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(memberForms.messagePage({ title: "Link no longer valid", message: "This link has expired or been replaced. Ask your steward for the current link." }));
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(memberForms.contactForm({ locations: await db.getLocationList(), token, localNo: await db.getOrgLocalNo() }));
      }
      if (req.method === "POST") {
        if (!contactSubmitAllowed(clientIp(req))) {
          return sendJson(res, 429, { error: "Too many submissions from this connection. Please wait a few minutes and try again." });
        }
        const body = await readBody(req);
        // A filled-in hidden field means an automatic form-filler. Pretend it worked.
        if (body && body.website) return sendJson(res, 200, { ok: true });
        try {
          const result = await db.submitContact(token, body);
          return sendJson(res, 200, { ok: true, updated: !!result.updated });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // One-time update link for a person's own entry. Sent to the personal email on
    // file. The form opens blank, so no existing details are shown.
    const updateMatch = pathname.match(/^\/update\/([a-f0-9]{48})$/);
    if (updateMatch) {
      const token = updateMatch[1];
      if (req.method === "GET") {
        const link = await db.getContactUpdateLink(token);
        if (!link) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(memberForms.messagePage({ title: "Link not found", message: "This link is not valid." }));
        }
        if (link.isUsed || link.isExpired) {
          res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(memberForms.messagePage({ title: "Link no longer valid", message: "This link has expired or has already been used. Ask your steward for a new one." }));
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(memberForms.contactForm({ locations: await db.getLocationList(), token, localNo: await db.getOrgLocalNo(), mode: "update" }));
      }
      if (req.method === "POST") {
        if (!contactSubmitAllowed(clientIp(req))) {
          return sendJson(res, 429, { error: "Too many submissions from this connection. Please wait a few minutes and try again." });
        }
        const body = await readBody(req);
        if (body && body.website) return sendJson(res, 200, { ok: true });
        try {
          const result = await db.submitContactUpdate(token, body);
          if (result.emailChanged) {
            contactUpdate.sendChangeConfirmation({ to: result.newPersonalEmail, legalName: result.legalName })
              .catch(err => console.error("[update] confirmation email failed:", err.message));
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // Unsubscribe from newsletters. The link is in every newsletter. Opening the
    // page does nothing; the button does the unsubscribing, so mail scanners that
    // open links do not unsubscribe people by accident.
    const unsubMatch = pathname.match(/^\/unsubscribe\/([a-f0-9]{32})$/);
    if (unsubMatch) {
      const token = unsubMatch[1];
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(memberForms.unsubscribePage({ token }));
      }
      if (req.method === "POST") {
        const ok = await db.unsubscribeByToken(token);
        if (!ok) return sendJson(res, 404, { error: "This link is not valid." });
        return sendJson(res, 200, { ok: true });
      }
    }

    // Public health-check endpoint, meant to be hit by an external
    // scheduler (see .github/workflows/keepalive.yml) on a fixed schedule
    // regardless of whether anyone is actually using the app. This is what
    // actually solves the pause problem: it wakes up Render's free web
    // service if it's asleep, and pingKeepAlive() inside it performs a real
    // database write, which is what resets Supabase's 7-day inactivity
    // clock. No login required -- an external cron job has no session.
    if (pathname === "/api/health" && req.method === "GET") {
      try {
        await db.pingKeepAlive();
        // The ping is what wakes a sleeping host, so it's also the moment to
        // make sure today's reminders have gone out. Fire-and-forget: never
        // slows or fails the health response (and it's throttled, so hitting
        // this public URL repeatedly can't trigger repeated work).
        scheduler.runDailyCheckIfDue().catch(() => {});
        return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // Auth routes (no session required)
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const rawUsername = String(body.username || "").trim();

      // Rate-limit check before hitting the DB
      const attemptKey = lockKey(rawUsername, clientIp(req));
      const lockMsg = loginCheckLock(attemptKey);
      if (lockMsg) return sendJson(res, 429, { error: lockMsg });

      const user = await db.verifyLogin(rawUsername, body.password);
      if (!user) {
        loginRecordFailure(attemptKey);
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }
      loginRecordSuccess(attemptKey);
      const token = await db.createSession(user.username);
      setSessionCookie(res, token);
      // Fire-and-forget keeps Supabase free-tier alive and records login.
      db.pingKeepAlive().catch(err => console.error("[index] Keep-alive ping failed:", err.message));
      db.writeAuditLog(user.username, "login", "", clientIp(req))
        .catch(err => console.error("[audit] login write failed:", err.message));
      return sendJson(res, 200, { ok: true, user });
    }

    if (pathname === "/api/auth/session" && req.method === "GET") {
      const user = await getCurrentUser(req);
      if (!user) return sendJson(res, 401, { error: "Not logged in." });
      db.pingKeepAlive().catch(err => console.error("[index] Keep-alive ping failed:", err.message));
      // The session stays valid while the user is active (30 minutes idle limit), so most visits never pass through
      // the login form. Record those visits too ("session" = opened the app
      // while still signed in). Throttled so page refreshes don't flood the log.
      if (user.username && sessionVisitShouldLog(user.username)) {
        db.writeAuditLog(user.username, "session", "", clientIp(req))
          .catch(err => console.error("[audit] session write failed:", err.message));
      }
      return sendJson(res, 200, { user });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = getSessionTokenFromRequest(req);
      // Look the user up before destroying the session -- the token is no
      // good for that lookup afterward.
      const loggingOutUser = token ? await getCurrentUser(req) : null;
      if (token) await db.destroySession(token);
      if (loggingOutUser && loggingOutUser.username) {
        db.writeAuditLog(loggingOutUser.username, "logout", "", clientIp(req))
          .catch(err => console.error("[audit] logout write failed:", err.message));
      }
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

    // Read-only accounts can look at everything they're scoped to (same as
    // a steward) but can never create, edit, delete, archive, hand off, or
    // upload anything. Changing their own password is still allowed -- that's
    // account self-service, not grievance data. Every other state-changing
    // request is blocked here, centrally, rather than in each route, so a
    // new write endpoint can't accidentally be left unguarded.
    if (currentUser.role === "read_only" && req.method !== "GET" && pathname !== "/api/auth/change-password" && pathname !== "/api/auth/activity") {
      return sendJson(res, 403, { error: "This is a read-only account. Ask an admin for edit access if you need to make changes." });
    }

    // Browser reports real user input (at most about once a minute). This is
    // the only thing that extends the 30-minute idle timeout for a session.
    if (pathname === "/api/auth/activity" && req.method === "POST") {
      await db.touchSession(getSessionTokenFromRequest(req));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/data" && req.method === "GET") {
      const data = await db.getAll();
      return sendJson(res, 200, scopeDataToUser(data, currentUser));
    }

    // ── Attachments ──────────────────────────────────────────────────
    // Upload/view: anyone who can access the grievance itself (its
    // location, or an admin). Delete: the uploader, or an admin only --
    // a steward can't remove evidence someone else attached.
    const ALLOWED_ATTACHMENT_TYPES = new Set([
      "application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain"
    ]);

    if (pathname === "/api/grievance/attachment" && req.method === "POST") {
      let body;
      try {
        body = await readBodyWithLimit(req, Math.ceil(MAX_ATTACHMENT_BYTES * 1.4));
      } catch (err) {
        return sendJson(res, 413, { error: err.message });
      }
      const gid = String(body.gid || "").trim();
      const filename = String(body.filename || "").trim().slice(0, 200);
      const contentType = String(body.contentType || "").trim();
      if (!gid || !filename || !body.dataBase64) {
        return sendJson(res, 400, { error: "Missing file, filename, or grievance ID." });
      }
      if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
        return sendJson(res, 400, { error: "That file type isn't allowed. Use a PDF, Word document, plain text, or image." });
      }
      if (!isAdmin(currentUser)) {
        const loc = await db.getGrievanceLocationById(gid);
        if (loc === null || !canAccessLocation(currentUser, loc)) {
          return sendJson(res, 403, { error: "You don't have access to this grievance." });
        }
      }
      let buffer;
      try {
        buffer = Buffer.from(body.dataBase64, "base64");
      } catch {
        return sendJson(res, 400, { error: "Could not read the uploaded file." });
      }
      if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) {
        return sendJson(res, 400, { error: "Files must be under 10MB." });
      }
      // Flat path (no "/"): the storage API treats slashes in object names
      // inconsistently with the encoding used here. The grievance is recorded
      // in the attachments table, so the folder isn't needed.
      const storagePath = `${Date.now()}-${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      try {
        await storage.uploadObject(storagePath, buffer, contentType);
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
      const record = await db.createAttachmentRecord({
        gid, filename, contentType, sizeBytes: buffer.length,
        storagePath, uploadedBy: currentUser.username
      });
      return sendJson(res, 200, record);
    }

    const attachmentMatch = pathname.match(/^\/api\/grievance\/attachment\/([a-zA-Z0-9-]+)$/);
    if (attachmentMatch && req.method === "GET") {
      const record = await db.getAttachmentRecord(attachmentMatch[1]);
      if (!record) return sendJson(res, 404, { error: "File not found." });
      if (!isAdmin(currentUser)) {
        const loc = await db.getGrievanceLocationById(record.gid);
        if (loc === null || !canAccessLocation(currentUser, loc)) {
          return sendJson(res, 403, { error: "You don't have access to this file." });
        }
      }
      let buffer;
      try {
        buffer = await storage.downloadObject(record.storagePath);
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
      res.writeHead(200, {
        "Content-Type": record.contentType || "application/octet-stream",
        "Content-Disposition": contentDisposition(record.filename),
        "Content-Length": buffer.length
      });
      return res.end(buffer);
    }

    if (attachmentMatch && req.method === "DELETE") {
      const record = await db.getAttachmentRecord(attachmentMatch[1]);
      if (!record) return sendJson(res, 404, { error: "File not found." });
      if (!isAdmin(currentUser) && record.uploadedBy !== currentUser.username) {
        return sendJson(res, 403, { error: "Only the person who uploaded a file (or an admin) can delete it." });
      }
      try {
        await storage.deleteObject(record.storagePath);
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
      await db.deleteAttachmentRecord(record.id);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/grievance" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser    = currentUser.displayName || currentUser.username;
      body.actorUsername = currentUser.username; // stable key used for lock ownership

      // Enforce location server-side -- never trust whatever the client
      // sent for this. A single-location user can't file anywhere but
      // their own location (their submitted value, if any, is ignored and
      // overridden); a multi-location ("super steward") user must submit
      // one of their own assigned locations; admins can set anything.
      if (!isAdmin(currentUser)) {
        const locations = userLocations(currentUser);
        if (locations.length === 0) {
          return sendJson(res, 403, { error: "You don't have a location assigned yet. Ask an admin to assign one in Manage Users before filing a grievance." });
        }

        // If this is an edit to an EXISTING grievance, also check the
        // record's CURRENT location -- otherwise a steward could craft a
        // direct request with someone else's grievance id and either edit
        // it or reassign it to their own location, even though they'd
        // never see it in their own list. A brand-new id (existingLocation
        // === null) has no current location to check yet.
        const existingLocation = body.id ? await db.getGrievanceLocationById(String(body.id).trim()) : null;
        if (existingLocation !== null && !canAccessLocation(currentUser, existingLocation)) {
          return sendJson(res, 403, { error: "You don't have access to this grievance." });
        }

        // Lock check: if this is an existing grievance locked to someone else, block the edit.
        if (body.id && existingLocation !== null) {
          const lockInfo = await db.getGrievanceLock(String(body.id).trim());
          if (lockInfo && lockInfo.lockedTo && lockInfo.lockedTo !== currentUser.username) {
            return sendJson(res, 403, {
              error: `This grievance is locked to ${lockInfo.lockedTo}. Ask them to hand it off to you before editing.`,
              lockedTo: lockInfo.lockedTo
            });
          }
        }

        if (locations.length === 1) {
          body.location = locations[0];
        } else if (!body.location || !locations.includes(body.location)) {
          return sendJson(res, 400, { error: "Select one of your assigned locations for this grievance." });
        }
      }

      let result;
      try {
        result = await db.submitGrievance(body);
      } catch (err) {
        // Duplicate grievance ID (app guard or DB trigger) -> clear 409, not a 500.
        if (err && (err.code === "23505" || /already exists in/.test(err.message || ""))) {
          return sendJson(res, 409, { error: err.message.replace(/^.*?(Grievance ID)/, "$1") });
        }
        throw err;
      }

      // If this grievance was started by converting an investigation, the
      // investigation is only now complete. Link them if the caller can see it.
      const investigationId = String(body.investigationId || "").trim();
      if (investigationId) {
        const inv = await db.getInvestigation(investigationId);
        if (inv && canAccessLocation(currentUser, inv.location)) {
          await db.linkGrievanceToInvestigation(investigationId, String(body.id).trim())
            .catch(err => console.error("[investigation] link failed:", err.message));
        }
      }

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
      if (!isAdmin(currentUser)) {
        const loc = await db.getGrievanceLocationById(String(body.gid || "").trim());
        if (loc === null || !canAccessLocation(currentUser, loc)) {
          return sendJson(res, 403, { error: "You don't have access to this grievance." });
        }
      }
      try {
        const result = await db.sendCourtesyNotice(body.gid, body.step);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // Hand off a grievance lock to another user.
    // Only the current lock holder or an admin may do this.
    if (pathname === "/api/grievance/handoff" && req.method === "POST") {
      const body = await readBody(req);
      const gid        = String(body.id || "").trim();
      const toUsername = String(body.toUsername || "").trim();
      if (!gid || !toUsername) {
        return sendJson(res, 400, { error: "id and toUsername are required." });
      }
      const lockInfo = await db.getGrievanceLock(gid);
      if (!lockInfo) {
        return sendJson(res, 404, { error: `Grievance ${gid} not found.` });
      }
      // An unlocked grievance has no holder to hand it off, so anyone who can
      // access its location may assign it. A locked one can only be passed on
      // by its holder (or an admin).
      if (!isAdmin(currentUser)) {
        if (lockInfo.lockedTo) {
          if (lockInfo.lockedTo !== currentUser.username) {
            return sendJson(res, 403, {
              error: `Only the current lock holder (${lockInfo.lockedTo}) or an admin can hand off this grievance.`
            });
          }
        } else if (!canAccessLocation(currentUser, lockInfo.location)) {
          return sendJson(res, 403, { error: "You don't have access to this grievance." });
        }
      }
      // Validate the target user exists so we can't orphan a grievance to a phantom username.
      const allUsers = await db.listUsersSafe();
      const targetUser = allUsers.find(u => u.username === toUsername);
      if (!targetUser) {
        return sendJson(res, 400, { error: `User "${toUsername}" not found. They may have been deleted.` });
      }
      // The receiver must be able to act on the case. A read-only account
      // can't edit it, and a steward at another location can't see it, so
      // either would leave the grievance locked to someone who can't work it.
      if (targetUser.role === "read_only") {
        return sendJson(res, 400, { error: `${targetUser.displayName || toUsername} has a read-only account and can't take over a grievance.` });
      }
      if (targetUser.role !== "admin" && !targetUser.locations.includes(lockInfo.location)) {
        return sendJson(res, 400, { error: `${targetUser.displayName || toUsername} doesn't have access to this grievance's location (${lockInfo.location || "none set"}).` });
      }
      try {
        const result = await db.handoffGrievance(gid, toUsername);
        // Fire-and-forget: tell the receiving steward by email. Never blocks
        // or fails the hand-off itself. Skipped when handing off to yourself.
        if (toUsername !== currentUser.username) {
          handoffNotify.sendHandoffNotification({
            gid, employee: lockInfo.employee || "", toUser: targetUser, fromUser: currentUser
          }).catch(err => console.error("[handoff] notification failed:", err.message));
        }
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // AI grievance-drafting assistant. Any logged-in user (steward or
    // admin) can use it — it only reads the contract text and the
    // conversation the steward types; it never touches the database.
    if (pathname === "/api/grievance-draft/chat" && req.method === "POST") {
      if (!canUseBot(currentUser)) {
        return sendJson(res, 403, { error: "Your account doesn't have access to the grievance-drafting assistant. Ask an admin to grant \"Steward Plus\" or \"Admin\" access." });
      }
      const body = await readBody(req);
      try {
        const [articleOptions, grievanceTypeOptions] = await Promise.all([
          db.getSetupList("Article"),
          db.getSetupList("GrievanceType")
        ]);
        const result = await grievanceDraftBot.chat(body.messages, { articleOptions, grievanceTypeOptions, chunkIds: body.chunkIds });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error("[grievance-draft] error:", err);
        return sendJson(res, 502, { error: err.message || "The drafting assistant is unavailable right now." });
      }
    }

    if (pathname === "/api/activity" && req.method === "POST") {
      const body = await readBody(req);
      if (!isAdmin(currentUser)) {
        const loc = await db.getGrievanceLocationById(String(body.gid || "").trim());
        if (loc === null || !canAccessLocation(currentUser, loc)) {
          return sendJson(res, 403, { error: "You don't have access to this grievance." });
        }
      }
      body.actingUser = currentUser.displayName || currentUser.username;
      const result = await db.logActivity(body);
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/archive" && req.method === "POST") {
      const admin = isAdmin(currentUser);
      const result = await db.archiveClosed(
        admin ? null : userLocations(currentUser),
        admin ? null : currentUser.username
      );
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

    if (pathname === "/api/location-details" && req.method === "GET") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can view location details." });
      return sendJson(res, 200, { details: await db.getLocationDetails() });
    }

    if (pathname === "/api/location-details" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can edit location details." });
      const body = await readBody(req);
      const result = await db.updateLocationDetails(body.details || {});
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
      if (body.role === "admin") {
        body.locations = []; // meaningless for admins -- they see every location regardless
      } else if (Array.isArray(body.locations)) {
        const validLocations = await db.getSetupList("Location");
        body.locations = body.locations.filter(l => validLocations.includes(l));
      }
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
      // A changed password must lock out whoever had the old one. Keep only
      // the session making this change.
      await db.deleteOtherSessions(currentUser.username, getSessionTokenFromRequest(req));
      return sendJson(res, 200, { ok: true });
    }

    // Shared contact links and the submissions they collect. Stewards and admins only.
    if (pathname.startsWith("/api/member-contacts")) {
      // Everyone with access to the app may view the list. Other actions need a steward or admin.
      const viewOnly = req.method === "GET" && pathname === "/api/member-contacts";
      if (!viewOnly && !canManageMemberContacts(currentUser)) {
        return sendJson(res, 403, { error: "Only stewards can see member contact details." });
      }
      if (pathname === "/api/member-contacts" && req.method === "GET") {
        return sendJson(res, 200, await db.listContacts());
      }
      if (pathname === "/api/member-contacts/export" && req.method === "GET") {
        const wanted = (url.searchParams.get("location") || "").trim();
        const locations = await db.getLocationList();
        if (wanted && !locations.includes(wanted)) {
          return sendJson(res, 400, { error: "That location is not in the location list." });
        }
        const { submissions } = await db.listContacts();
        const rows = wanted ? submissions.filter(r => r.location === wanted) : submissions;
        const header = ["Submitted", "Location", "Legal name", "Phone", "Personal email", "State email"];
        const lines = [header.map(csvCellValue).join(",")].concat(rows.map(r => [
          r.submittedAt ? r.submittedAt.slice(0, 10) : "", r.location, r.legalName, r.phone, r.personalEmail, r.stateEmail
        ].map(csvCellValue).join(",")));
        const scope = wanted || "all";
        const slug = wanted ? wanted.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "all";
        const date = new Date().toISOString().slice(0, 10);
        // Every export is recorded: this file holds personal contact details.
        await db.writeAuditLog(currentUser.username, "member_export", `${rows.length} row(s), ${scope}`, clientIp(req))
          .catch(err => console.error("[audit] member export log failed:", err.message));
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="members-${slug}-${date}.csv"`,
          "Cache-Control": "no-store"
        });
        return res.end("\uFEFF" + lines.join("\r\n") + "\r\n");
      }
      if (pathname === "/api/member-contacts/link" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const created = await db.createContactLink(currentUser.username);
          const proto = req.headers["x-forwarded-proto"] || "https";
          const host = req.headers.host || "";
          return sendJson(res, 200, {
            url: `${proto}://${host}/contact/${created.token}`,
            expiresAt: created.expiresAt
          });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/member-contacts/revoke" && req.method === "POST") {
        if (!canEditMemberContacts(currentUser)) return sendJson(res, 403, { error: "Only admins and super stewards can revoke the link." });
        try {
          await readBody(req);
          return sendJson(res, 200, await db.revokeContactLink());
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/member-contacts/send-update" && req.method === "POST") {
        if (!canEditMemberContacts(currentUser)) return sendJson(res, 403, { error: "Only admins and super stewards can send update links." });
        try {
          const body = await readBody(req);
          const proto = req.headers["x-forwarded-proto"] || "https";
          const host = req.headers.host || "";
          const sent = await contactUpdate.sendUpdateLink({
            submissionId: body.id,
            createdBy: currentUser.username,
            baseUrl: `${proto}://${host}`
          });
          return sendJson(res, 200, { ok: true, sentTo: sent.sentTo });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/member-contacts/update" && req.method === "POST") {
        if (!canEditMemberContacts(currentUser)) return sendJson(res, 403, { error: "Only admins and super stewards can edit entries." });
        try {
          const body = await readBody(req);
          const result = await db.updateContactSubmission(body.id, body);
          // The log records which fields changed, not their values.
          await db.writeAuditLog(currentUser.username, "member_edit",
            `${String(body.id || "").slice(0, 40)}: ${result.changed.join(", ") || "no changes"}`, clientIp(req))
            .catch(err => console.error("[audit] member edit log failed:", err.message));
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/member-contacts/remove" && req.method === "POST") {
        if (!canEditMemberContacts(currentUser)) return sendJson(res, 403, { error: "Only admins and super stewards can remove entries." });
        try {
          const body = await readBody(req);
          return sendJson(res, 200, await db.removeContactSubmission(body.id));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // Newsletters to members who opted in. Admins can send to any location or the
    // whole local. Stewards can send only to their own locations. Read-only accounts
    // cannot send or see the list.
    if (pathname.startsWith("/api/newsletters")) {
      // Everyone with access to the app may read the history. Sending needs more.
      const readOnly = req.method === "GET" && pathname === "/api/newsletters";
      if (!readOnly && !canManageMemberContacts(currentUser)) {
        return sendJson(res, 403, { error: "Only stewards and admins can send newsletters." });
      }
      if (req.method === "POST" && !["admin", "steward_plus"].includes(currentUser.role)) {
        return sendJson(res, 403, { error: "Only admins and super stewards can send newsletters." });
      }
      const baseUrlOf = () => `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || ""}`;
      const localNo = await db.getOrgLocalNo().catch(() => "");
      if (pathname === "/api/newsletters" && req.method === "GET") {
        const rows = await db.listNewsletterRecords(currentUser.username, currentUser.role === "admin");
        return sendJson(res, 200, { newsletters: rows });
      }
      if (pathname === "/api/newsletters/preview" && req.method === "POST") {
        try {
          const body = await readBody(req);
          if (!canSendNewsletterTo(currentUser, body.audience, body.location)) {
            return sendJson(res, 403, { error: "You can send newsletters only to your own location." });
          }
          const loc = body.audience === "location" ? String(body.location || "").trim() : "";
          const isNotice = body.kind === "notice";
          const people = await newsletter.recipientsFor({
            kind: isNotice ? "notice" : "newsletter",
            location: loc,
            addressType: isNotice ? "state" : (body.addressType === "state" ? "state" : "personal")
          });
          return sendJson(res, 200, { recipients: people.length });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/newsletters/test" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const sent = await newsletter.sendTest({ kind: body.kind, subject: body.subject, body: body.body, addressType: body.addressType, reason: body.reason, businessConfirm: body.businessConfirm, baseUrl: baseUrlOf(), localNo });
          return sendJson(res, 200, { ok: true, sentTo: sent.sentTo });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (pathname === "/api/newsletters/send" && req.method === "POST") {
        try {
          const body = await readBody(req);
          if (!canSendNewsletterTo(currentUser, body.audience, body.location)) {
            return sendJson(res, 403, { error: "You can send newsletters only to your own location." });
          }
          const started = await newsletter.startNewsletter({
            kind: body.kind, subject: body.subject, body: body.body, audience: body.audience, location: body.location,
            addressType: body.addressType, reason: body.reason, businessConfirm: body.businessConfirm,
            sentBy: currentUser.username, baseUrl: baseUrlOf(), localNo
          });
          return sendJson(res, 202, { ok: true, id: started.id, recipients: started.recipients });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    // Email
    if (pathname === "/api/email/status" && req.method === "GET") {
      const data = await db.getAll();
      const emailConfigured = !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
      // Admin-only: entries name grievants' and stewards' email addresses
      // across every location. Up to 200 newest entries are kept.
      const emailLog = isAdmin(currentUser) ? await db.getEmailLog(200) : [];
      return sendJson(res, 200, {
        emailConfigured,
        lastEmailRunDate: data.lastEmailRunDate || "",
        emailLog
      });
    }

    if (pathname === "/api/email/run-now" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can trigger the email run." });
      const summary = await scheduler.runDeadlineCheck({ manual: true });
      return sendJson(res, 200, summary);
    }

    // ── INVESTIGATION WORKFLOW API ROUTES ──────────────────────────────────

    if (pathname === "/api/investigations" && req.method === "GET") {
      const all = await db.getAllInvestigations();
      // Scope to user's locations (same rule as grievances)
      const visible = isAdmin(currentUser)
        ? all
        : all.filter(inv => canAccessLocation(currentUser, inv.location));
      return sendJson(res, 200, { investigations: visible });
    }

    if (pathname === "/api/investigation" && req.method === "POST") {
      const body = await readBody(req);
      if (!isAdmin(currentUser)) {
        const locs = userLocations(currentUser);
        if (!locs.length) return sendJson(res, 403, { error: "No location assigned — ask an admin." });
        if (locs.length === 1) body.location = locs[0];
        else if (!body.location || !locs.includes(body.location))
          return sendJson(res, 400, { error: "Select one of your assigned locations." });
      }
      body.actingUser = currentUser.displayName || currentUser.username;
      const inv = await db.createInvestigation({
        location: body.location,
        steward: body.steward,
        employee: body.employee,
        contactEmail: body.contactEmail,
        actingUser: body.actingUser
      });
      return sendJson(res, 200, { investigation: inv });
    }

    if (pathname === "/api/investigation/update" && req.method === "POST") {
      const body = await readBody(req);
      const id = body.id;
      const inv = await db.getInvestigation(id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const SAFE_FIELDS = ["employee", "contactEmail", "contactPhone", "incidentDescription", "incidentDates", "steward"];
      const patch = {};
      for (const f of SAFE_FIELDS) if (body[f] !== undefined) patch[f] = body[f];
      const updated = await db.updateInvestigation(id, patch);
      return sendJson(res, 200, { investigation: updated });
    }

    if (pathname === "/api/investigation/logbook" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const entry = await db.addInvestigationLogEntry(body.id, {
        date: body.date, entry: body.entry,
        steward: currentUser.displayName || currentUser.username
      });
      return sendJson(res, 200, { entry });
    }

    if (pathname === "/api/investigation/close" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      try {
        const updated = await db.closeInvestigation(body.id, { reason: body.reason, notes: body.notes });
        return sendJson(res, 200, { investigation: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/investigation/convert" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      try {
        const pre = await db.convertInvestigationToGrievance(
          body.id, body.grievanceId, currentUser.displayName || currentUser.username
        );
        return sendJson(res, 200, { preFilledGrievance: pre });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/investigation/grievant-link" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const { token, expiresAt } = await db.createInvestigationToken(body.id, "grievant");
      return sendJson(res, 200, { token, expiresAt });
    }

    if (pathname === "/api/investigation/archive" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const updated = await db.archiveInvestigation(body.id);
      return sendJson(res, 200, { investigation: updated });
    }

    if (pathname === "/api/investigation/unarchive" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const updated = await db.unarchiveInvestigation(body.id);
      return sendJson(res, 200, { investigation: updated });
    }

    if (pathname === "/api/investigation/draft-chat" && req.method === "POST") {
      if (!canUseBot(currentUser)) return sendJson(res, 403, { error: "No bot access." });
      const body = await readBody(req);
      // If an investigationId is provided, inject the investigation facts as
      // the first user message so the bot has all the context it needs
      let messages = body.messages || [];
      if (body.investigationId) {
        const inv = await db.getInvestigation(body.investigationId);
        if (inv && canAccessLocation(currentUser, inv.location)) {
          const sub = inv.grievantSubmission && inv.grievantSubmission.data;
          const witnesses = (inv.witnessStatements || []).filter(w => w.statement);
          let context = `[Investigation context — carry this into the grievance draft]
Investigation ID: ${inv.id}
Employee: ${inv.employee || "(not yet known)"}
Location: ${inv.location || "(not set)"}
Steward: ${inv.steward || "(not set)"}`;
          if (sub) {
            context += `\n\nEmployee's own statement (submitted via intake form on ${sub.submittedAt ? sub.submittedAt.slice(0,10) : "unknown date"}):
Name: ${sub.name || ""}
Email: ${sub.email || ""}
Incident date: ${sub.incidentDate || ""}
Description: ${sub.description || ""}
Witnesses mentioned: ${sub.witnesses || "(none)"}
Additional details: ${sub.otherDetails || ""}`;
          } else if (inv.incidentDescription) {
            context += `\n\nIncident description (entered by steward): ${inv.incidentDescription}`;
          }
          if (witnesses.length) {
            context += `\n\nWitness statement(s):`;
            witnesses.forEach((w, i) => {
              context += `\n${i+1}. ${w.witnessName}: ${w.statement}`;
            });
          }
          const logEntries = (inv.logbook || []).slice(-5); // last 5 entries
          if (logEntries.length) {
            context += `\n\nSteward logbook (most recent entries):`;
            logEntries.forEach(l => { context += `\n[${l.date}] ${l.entry}`; });
          }
          // Prepend the investigation context as the first message if this is a new conversation
          if (!messages.length || messages[0].role !== "user" || !messages[0].content.startsWith("[Investigation context")) {
            messages = [{ role: "user", content: context }, ...messages];
          }
        }
      }
      try {
        const [articleOptions, grievanceTypeOptions] = await Promise.all([
          db.getSetupList("Article"), db.getSetupList("GrievanceType")
        ]);
        const result = await grievanceDraftBot.chat(messages, {
          articleOptions, grievanceTypeOptions, chunkIds: body.chunkIds
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 502, { error: err.message || "The drafting assistant is unavailable right now." });
      }
    }

    /* ------------------------------------------------------------------ */
    /* Grievance Number Pool (admin-only management + any-steward consume) */
    /* ------------------------------------------------------------------ */

    // GET  /api/grievance-pool        — pool status (remaining count, unused numbers in assignment order, log)
    if (pathname === "/api/grievance-pool" && req.method === "GET") {
      // Any logged-in user may see the pool status and assignment log.
      const result = await db.getGrievanceNumberPool();
      return sendJson(res, 200, { remaining: result.pool.length, numbers: result.pool, log: result.log });
    }

    // POST /api/grievance-pool/add    — any user adds a batch of numbers
    if (pathname === "/api/grievance-pool/add" && req.method === "POST") {
      // Any logged-in user may add numbers (stewards receive batches too).
      // Clearing the pool stays admin-only.
      const body = await readBody(req);
      // Accept either an array or a newline/comma-delimited string
      let numbers = body.numbers || [];
      if (typeof numbers === "string") {
        numbers = numbers.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      }
      if (!Array.isArray(numbers) || numbers.length === 0) {
        return sendJson(res, 400, { error: "Provide at least one grievance number." });
      }
      const result = await db.addToGrievanceNumberPool(numbers, currentUser.username);
      return sendJson(res, 200, result);
    }

    // POST /api/grievance-pool/clear  — admin empties the pool
    if (pathname === "/api/grievance-pool/clear" && req.method === "POST") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can clear the number pool." });
      const result = await db.clearGrievanceNumberPool();
      return sendJson(res, 200, result);
    }

    // POST /api/grievance-pool/consume — intake form claims the next number
    if (pathname === "/api/grievance-pool/consume" && req.method === "POST") {
      // Any logged-in steward may claim a number; no extra role check needed.
      const result = await db.consumeNextGrievanceNumber(currentUser.username);
      return sendJson(res, 200, result);
    }

    // POST /api/grievance-pool/return — put an unused number back (form cleared without saving)
    if (pathname === "/api/grievance-pool/return" && req.method === "POST") {
      const body = await readBody(req);
      const number = String(body.number || "").trim();
      if (!number) return sendJson(res, 400, { error: "number is required." });
      const result = await db.returnGrievanceNumber(number, {
        username: currentUser.username,
        isAdmin: isAdmin(currentUser)
      });
      return sendJson(res, 200, result);
    }

    // ── AUDIT LOG ──────────────────────────────────────────────────────────

    // POST /api/audit — client-side fire-and-forget ping (tab nav, record open)
    if (pathname === "/api/audit" && req.method === "POST") {
      const body = await readBody(req);
      const action = String(body.action || "").trim();
      const detail = String(body.detail || "").trim();
      const ALLOWED_ACTIONS = new Set(["tab", "record_open"]);
      if (!ALLOWED_ACTIONS.has(action)) return sendJson(res, 400, { error: "Invalid action." });
      db.writeAuditLog(currentUser.username, action, detail, clientIp(req))
        .catch(err => console.error("[audit] client ping failed:", err.message));
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/audit/log — admin-only: fetch recent entries
    if (pathname === "/api/audit/log" && req.method === "GET") {
      if (!isAdmin(currentUser)) return sendJson(res, 403, { error: "Only admins can view the audit log." });
      const url = new URL(req.url, "http://x");
      const filterUser = url.searchParams.get("user") || null;
      const requestedLimit = parseInt(url.searchParams.get("limit") || "200", 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 200;
      const AUDIT_ACTIONS = new Set(["login", "logout", "session", "tab", "record_open"]);
      const filterActions = (url.searchParams.get("actions") || "")
        .split(",").map(s => s.trim()).filter(a => AUDIT_ACTIONS.has(a));
      const rows = await db.getAuditLog(limit, filterUser, filterActions);
      return sendJson(res, 200, { rows });
    }

    return sendJson(res, 404, { error: "Unknown API route" });

  } catch (err) {
    if (err && err.statusCode) return sendJson(res, err.statusCode, { error: err.message });
    console.error("Server error:", err);
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`FCRC Grievance Tracker running on port ${PORT}`);
  scheduler.startScheduler();

  // Keep Supabase free-tier alive — ping the DB every 5 days so it never
  // reaches the 7-day inactivity threshold and pauses.
  const KEEP_ALIVE_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  db.pingKeepAlive().catch(err => console.error("[keep-alive] initial ping failed:", err.message));
  setInterval(() => {
    db.pingKeepAlive().catch(err => console.error("[keep-alive] scheduled ping failed:", err.message));
  }, KEEP_ALIVE_INTERVAL_MS);
});

// Exported for unit testing only (see __selftest__/run_bot_permission_test.js).
// index.js still starts listening immediately on require, same as before —
// these exports don't change runtime behavior.
module.exports = { isAdmin, canUseBot, userLocations, canAccessLocation, scopeDataToUser };
