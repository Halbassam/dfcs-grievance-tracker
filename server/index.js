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
const grievanceDraftBot = require("./grievanceDraftBot");
const investigationForms = require("./investigationForms");

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
  // since activity can reference either).
  const visibleGids = new Set([...grievances, ...archive].map(g => g.id));
  const activity = data.activity.filter(a => visibleGids.has(a.gid));

  return { ...data, grievances, activity, archive };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  try {
    // ── PUBLIC FORM ROUTES (no authentication required) ────────────────────
    // Served at /intake/:token and /witness/:token — these are the mobile-
    // friendly forms sent to grievants and witnesses via link.

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
      return sendJson(res, 200, scopeDataToUser(data, currentUser));
    }

    if (pathname === "/api/grievance" && req.method === "POST") {
      const body = await readBody(req);
      body.actingUser = currentUser.displayName || currentUser.username;

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

        if (locations.length === 1) {
          body.location = locations[0];
        } else if (!body.location || !locations.includes(body.location)) {
          return sendJson(res, 400, { error: "Select one of your assigned locations for this grievance." });
        }
      }

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
      const updated = await db.closeInvestigation(body.id, { reason: body.reason, notes: body.notes });
      return sendJson(res, 200, { investigation: updated });
    }

    if (pathname === "/api/investigation/convert" && req.method === "POST") {
      const body = await readBody(req);
      const inv = await db.getInvestigation(body.id);
      if (!inv) return sendJson(res, 404, { error: "Investigation not found." });
      if (!canAccessLocation(currentUser, inv.location)) return sendJson(res, 403, { error: "Access denied." });
      const pre = await db.convertInvestigationToGrievance(
        body.id, body.grievanceId, currentUser.displayName || currentUser.username
      );
      return sendJson(res, 200, { preFilledGrievance: pre });
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

// Exported for unit testing only (see __selftest__/run_bot_permission_test.js).
// index.js still starts listening immediately on require, same as before —
// these exports don't change runtime behavior.
module.exports = { isAdmin, canUseBot, userLocations, canAccessLocation, scopeDataToUser };
