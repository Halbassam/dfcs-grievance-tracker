/**
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Database layer — Supabase Postgres backend.
 */

const { query, withTransaction } = require("./pool");
const { hashPassword, verifyPassword } = require("./passwords");
const crypto = require("crypto");

const SIMPLE_SETUP_KEYS = [
  "Status", "Bureau", "Location", "County", "BargainingUnit",
  "JobClass", "Shift", "Article", "GrievanceType", "ActivityType"
];

const DATE_FIELDS = [
  "awareness", "step1filed", "step1resp", "step2filed",
  "step2resp", "step3filed", "step3resp", "step4filed"
];

const TERMINAL_STATUSES = [
  "Settled", "Denied", "Withdrawn", "Granted", "Partially Granted"
];

async function getAll() {
  const [
    grievancesRes, activityRes, archiveRes, usersRes, sessionsRes,
    holidaysRes, setupRes, emailLogRes, metaRes
  ] = await Promise.all([
    query("select data from grievances order by created_at asc"),
    query("select data from activity order by row_id asc"),
    query("select data from archive order by created_at asc"),
    query("select username, display_name, role, created_at, password_hash from users"),
    query("select token, username, expires_at from sessions"),
    query("select date, name from holidays order by date asc"),
    query("select key, items from setup_lists"),
    query("select data from email_log order by row_id desc limit 60"),
    query("select key, value from app_meta")
  ]);

  const setup = {};
  for (const row of setupRes.rows) setup[row.key] = row.items || [];

  const users = usersRes.rows.map(r => ({
    username: r.username,
    displayName: r.display_name,
    role: r.role || "steward",
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    passwordHash: r.password_hash
  }));

  const sessions = sessionsRes.rows.map(r => ({
    token: r.token,
    username: r.username,
    expiresAt: r.expires_at instanceof Date ? r.expires_at.getTime() : Number(r.expires_at)
  }));

  const metaMap = {};
  for (const row of metaRes.rows) metaMap[row.key] = row.value;

  return {
    grievances: grievancesRes.rows.map(r => r.data),
    activity:   activityRes.rows.map(r => r.data),
    archive:    archiveRes.rows.map(r => r.data),
    emailLog:   emailLogRes.rows.map(r => r.data),
    users, sessions,
    lastEmailRunDate: metaMap.lastEmailRunDate || "",
    holidays: holidaysRes.rows.map(r => ({ date: r.date, name: r.name })),
    setup,
    orgSettings: {
      agency:   metaMap.orgAgency   || "",
      localNo:  metaMap.orgLocalNo  || "",
      bureau:   metaMap.orgBureau   || "",
      location: metaMap.orgLocation || "",
      county:   metaMap.orgCounty   || "",
      shift:    metaMap.orgShift    || "",
      managementEmail: metaMap.orgManagementEmail || ""
    }
  };
}

async function readRaw() { return getAll(); }

async function submitGrievance(record) {
  const id = String(record.id || "").trim();
  if (!id) throw new Error("Grievance ID is required.");

  return withTransaction(async (client) => {
    const existing = await client.query("select data from grievances where id = $1", [id]);
    const isNew = existing.rows.length === 0;
    const target = isNew ? { id } : { ...existing.rows[0].data };

    // Capture "was this step already filed before this save?" BEFORE
    // we overwrite the date fields below, so the caller can tell which
    // steps were just newly filed in this specific save (used to decide
    // whether to send a grievant progress-notification email).
    const wasFiledBefore = {
      step1: !!target.step1filed,
      step2: !!target.step2filed,
      step3: !!target.step3filed
    };

    target.employee     = record.employee     || "";
    target.grievantEmail = record.grievantEmail || "";
    target.description  = record.description  || "";
    target.jobClass     = record.jobClass     || "";
    target.bu           = record.bu           || "";
    target.steward      = record.steward      || "";
    target.stewardEmail = record.stewardEmail || "";
    target.gtype        = record.gtype        || "";
    target.article      = record.article      || "";
    target.section      = record.section      || "";
    target.remedy       = record.remedy       || "";
    target.status       = record.status       || "Pending";

    for (const field of DATE_FIELDS) {
      if (record[field]) target[field] = record[field];
    }

    target.createdAt = target.createdAt || record.createdAt || new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    target.createdBy = target.createdBy || record.actingUser || "";
    target.updatedBy = record.actingUser || "";
    target.id = id;

    await client.query(
      `insert into grievances (id, status, steward, data, updated_at)
       values ($1, $2, $3, $4::jsonb, now())
       on conflict (id) do update
         set status = excluded.status, steward = excluded.steward,
             data = excluded.data, updated_at = now()`,
      [id, target.status, target.steward, JSON.stringify(target)]
    );

    // Which steps were just newly filed in THIS save (blank before, has
    // a date now)? Used by the caller to decide which grievant
    // progress-notification email(s), if any, to send.
    const newlyFiledSteps = {
      step1: !wasFiledBefore.step1 && !!target.step1filed,
      step2: !wasFiledBefore.step2 && !!target.step2filed,
      step3: !wasFiledBefore.step3 && !!target.step3filed
    };

    return { isNew, record: { ...target }, newlyFiledSteps };
  });
}

/**
 * Sends a one-time courtesy reminder email to management (the org-wide
 * management contact set in Settings) about a Step 1 or Step 2 response
 * deadline. This is always a manual, steward-triggered action — never
 * automatic — and can only be sent once per step per grievance; the
 * step1CourtesySent / step2CourtesySent flags on the record enforce
 * that (checked here server-side, not just hidden in the UI).
 *
 * Returns { ok: true, deadlineDate } on success. Throws a descriptive
 * Error if the step is invalid, already sent, has no computable
 * deadline yet, or if management email / Brevo aren't configured.
 */
async function sendCourtesyNotice(gid, step) {
  if (step !== "step1" && step !== "step2") {
    throw new Error('Courtesy notices are only available for "step1" or "step2".');
  }

  const sentFlagKey = step === "step1" ? "step1CourtesySent" : "step2CourtesySent";

  return withTransaction(async (client) => {
    const existing = await client.query("select data from grievances where id = $1", [gid]);
    if (existing.rows.length === 0) throw new Error(`Grievance ${gid} not found.`);
    const rec = existing.rows[0].data;

    if (rec[sentFlagKey]) {
      throw new Error(`A courtesy notice for ${step === "step1" ? "Step 1" : "Step 2"} has already been sent for this grievance.`);
    }

    const metaRes = await client.query("select key, value from app_meta");
    const metaMap = {};
    for (const row of metaRes.rows) metaMap[row.key] = row.value;
    const managementEmail = (metaMap.orgManagementEmail || "").trim();
    if (!managementEmail) {
      throw new Error("No management contact email is set. Go to Settings \u2192 Local chapter info to add one.");
    }

    const apiKey = process.env.BREVO_API_KEY || "";
    const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
    if (!apiKey || !senderEmail) {
      throw new Error("Email is not configured (BREVO_API_KEY / BREVO_SENDER_EMAIL). See server/mailer.js for setup steps.");
    }

    const holidaysRes = await client.query("select date, name from holidays");
    const holidaySet = buildHolidaySet(holidaysRes.rows);
    const d = deriveDeadlinesServer(rec, holidaySet);
    const dueDate = step === "step1" ? d.step1Due : d.step2AnswerDue;
    if (!dueDate) {
      throw new Error(`No ${step === "step1" ? "Step 1 response" : "Step 2 answer"} deadline could be calculated yet for this grievance.`);
    }
    const dueDateISO = toISODate(dueDate);

    const stepLabel = step === "step1" ? "Step 1 (Oral Grievance)" : "Step 2 (Written Grievance)";
    const subject = `Courtesy Reminder: ${stepLabel} response due ${dueDateISO} — Grievance ${gid}`;
    const text = [
      `This is a courtesy reminder regarding Grievance ${gid} (${rec.employee || ""}).`,
      "",
      `A response at ${stepLabel} is due by ${dueDateISO} under the Master Agreement.`,
      "",
      "This notice is sent as a courtesy and does not waive or extend any contractual deadline.",
      "",
      `— AFSCME Council 31 FCRC${rec.steward ? ", " + rec.steward : ""}`
    ].join("\n");

    const { sendMail } = require("./mailer");
    await sendMail({ apiKey, senderEmail, to: managementEmail, subject, text });

    const updated = { ...rec, [sentFlagKey]: true, [`${step}CourtesySentAt`]: new Date().toISOString() };
    await client.query(
      `update grievances set data = $2::jsonb, updated_at = now() where id = $1`,
      [gid, JSON.stringify(updated)]
    );

    await logEmailAttempt({
      kind: "management-courtesy-notice", gid, step, to: managementEmail, ok: true
    }).catch(logErr => console.error("[db] Failed to write email log entry:", logErr.message));

    return { ok: true, deadlineDate: dueDateISO, record: updated };
  });
}

async function logActivity(record) {
  const entry = {
    id: record.id, gid: record.gid, date: record.date, type: record.type,
    steward: record.steward, step: record.step, notes: record.notes,
    followup: record.followup || "No", followupDate: record.followupDate || "",
    enteredBy: record.actingUser || ""
  };
  await query("insert into activity (gid, data) values ($1, $2::jsonb)",
    [record.gid, JSON.stringify(entry)]);
  return { ok: true };
}

async function archiveClosed() {
  return withTransaction(async (client) => {
    const archivedAt = new Date().toISOString().slice(0, 10);
    const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 1}`).join(", ");
    const res = await client.query(
      `select id, status, steward, data from grievances where status in (${placeholders})`,
      TERMINAL_STATUSES
    );
    let archivedCount = 0;
    for (const row of res.rows) {
      const archivedRecord = { ...row.data, archivedAt };
      await client.query(
        `insert into archive (id, status, steward, archived_at, data)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (id) do update
           set status = excluded.status, steward = excluded.steward,
               archived_at = excluded.archived_at, data = excluded.data`,
        [row.id, row.status, row.steward, archivedAt, JSON.stringify(archivedRecord)]
      );
      archivedCount++;
    }
    if (res.rows.length) {
      await client.query(
        `delete from grievances where status in (${placeholders})`, TERMINAL_STATUSES
      );
    }
    return { archivedCount };
  });
}

async function updateStewards(stewards, emails) {
  if (!Array.isArray(stewards) || !Array.isArray(emails))
    throw new Error("Stewards and emails must both be arrays.");
  if (stewards.length !== emails.length)
    throw new Error("Steward names and emails must be the same length.");
  const cleanStewards = stewards.map(s => String(s || "").trim()).filter(s => s !== "");
  const cleanEmails = emails.slice(0, cleanStewards.length).map(e => String(e || "").trim());
  await withTransaction(async (client) => {
    await client.query(
      `insert into setup_lists (key, items) values ('Steward', $1::jsonb)
       on conflict (key) do update set items = excluded.items`,
      [JSON.stringify(cleanStewards)]
    );
    await client.query(
      `insert into setup_lists (key, items) values ('StewardEmail', $1::jsonb)
       on conflict (key) do update set items = excluded.items`,
      [JSON.stringify(cleanEmails)]
    );
  });
  return { ok: true, count: cleanStewards.length };
}

async function updateSetupList(key, items) {
  if (!SIMPLE_SETUP_KEYS.includes(key)) throw new Error(`Unknown setup list: ${key}`);
  if (!Array.isArray(items)) throw new Error("Items must be an array.");
  const cleanItems = items.map(s => String(s || "").trim()).filter(s => s !== "");
  await query(
    `insert into setup_lists (key, items) values ($1, $2::jsonb)
     on conflict (key) do update set items = excluded.items`,
    [key, JSON.stringify(cleanItems)]
  );
  return { ok: true, count: cleanItems.length };
}

function isValidISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }

async function updateHolidays(holidays) {
  if (!Array.isArray(holidays)) throw new Error("Holidays must be an array.");
  const clean = holidays
    .map(h => ({ date: String((h && h.date) || "").trim(), name: String((h && h.name) || "").trim() }))
    .filter(h => isValidISODate(h.date) && h.name !== "");
  clean.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  await withTransaction(async (client) => {
    await client.query("delete from holidays");
    for (const h of clean)
      await client.query("insert into holidays (date, name) values ($1, $2)", [h.date, h.name]);
  });
  return { ok: true, count: clean.length };
}

async function updateOrgSettings({ agency, localNo, bureau, location, county, shift, managementEmail }) {
  const clean = {
    orgAgency:   String(agency   || "").trim(),
    orgLocalNo:  String(localNo  || "").trim(),
    orgBureau:   String(bureau   || "").trim(),
    orgLocation: String(location || "").trim(),
    orgCounty:   String(county   || "").trim(),
    orgShift:    String(shift    || "").trim(),
    orgManagementEmail: String(managementEmail || "").trim()
  };
  await withTransaction(async (client) => {
    for (const [key, value] of Object.entries(clean)) {
      await client.query(
        `insert into app_meta (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value`,
        [key, value]
      );
    }
  });
  return {
    ok: true,
    agency: clean.orgAgency, localNo: clean.orgLocalNo, bureau: clean.orgBureau,
    location: clean.orgLocation, county: clean.orgCounty, shift: clean.orgShift,
    managementEmail: clean.orgManagementEmail
  };
}

// Deadline calculation
function toDateLocal(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISODate(d) {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function isWeekend(d) { const w = d.getDay(); return w === 0 || w === 6; }
function buildHolidaySet(holidays) { return new Set((holidays || []).map(h => h.date)); }
function workday(startISO, days, holidaySet) {
  let d = toDateLocal(startISO);
  if (!d) return null;
  let remaining = Math.abs(days);
  const step = days >= 0 ? 1 : -1;
  while (remaining > 0) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
    if (!isWeekend(d) && !holidaySet.has(toISODate(d))) remaining--;
  }
  return d;
}
function addCalendarDays(startISO, days) {
  const d = toDateLocal(startISO);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

const TERMINAL_FOR_DEADLINES = ["Settled","Granted","Denied","Withdrawn","Partially Granted"];

function deriveDeadlinesServer(rec, holidaySet) {
  const d = {};
  d.step1Due = rec.step1filed ? workday(rec.step1filed, 10, holidaySet) : null;
  const step2FilingBasis = rec.step1resp || (d.step1Due ? toISODate(d.step1Due) : null);
  d.step2FilingDue = step2FilingBasis ? workday(step2FilingBasis, 5, holidaySet) : null;
  d.step2MeetingDue = rec.step2filed ? workday(rec.step2filed, 10, holidaySet) : null;
  d.step2AnswerDue  = d.step2MeetingDue ? workday(toISODate(d.step2MeetingDue), 5, holidaySet) : null;
  const step3FilingBasis = rec.step2resp || (d.step2AnswerDue ? toISODate(d.step2AnswerDue) : null);
  d.step3FilingDue = step3FilingBasis ? workday(step3FilingBasis, 15, holidaySet) : null;
  d.step3SignDue = rec.step3filed ? workday(rec.step3filed, 10, holidaySet) : null;
  const step4FilingBasis = rec.step3resp || (d.step3SignDue ? toISODate(d.step3SignDue) : null);
  d.step4FilingDue = step4FilingBasis ? workday(step4FilingBasis, 15, holidaySet) : null;
  d.arbHearingDue = rec.step4filed ? addCalendarDays(rec.step4filed, 60) : null;
  return d;
}

function isResolvedRec(rec) { return TERMINAL_FOR_DEADLINES.includes(rec.status); }

function nextDeadlineServer(rec, holidaySet) {
  if (isResolvedRec(rec)) return null;
  // Once Step 3 has been filed, no further alerts are generated —
  // Council 31 staff track everything from Step 3 sign-off onward.
  if (rec.step3filed) return null;
  const d = deriveDeadlinesServer(rec, holidaySet);
  const candidates = [];
  if (d.step1Due       && !rec.step1resp)  candidates.push({ date: d.step1Due,       label: "Step 1 response due" });
  if (d.step2AnswerDue && !rec.step2resp)  candidates.push({ date: d.step2AnswerDue, label: "Step 2 answer due" });
  if (d.step2FilingDue && !rec.step2filed) candidates.push({ date: d.step2FilingDue, label: "Step 2 filing deadline" });
  if (d.step3FilingDue && !rec.step3filed) candidates.push({ date: d.step3FilingDue, label: "Step 3 filing deadline" });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.date < b.date ? a : b));
}

/**
 * Returns "today" as a local Date object representing midnight in
 * America/Chicago (the FCRC's local timezone), regardless of what
 * timezone the server's own clock is set to. Render's servers run
 * on UTC, so using new Date() directly can silently be a day ahead
 * for anything checked in the evening Central time — this avoids
 * that by reading the actual Chicago calendar date first.
 */
function todayInChicago() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return new Date(Number(map.year), Number(map.month) - 1, Number(map.day));
}

/**
 * Finds every non-resolved grievance whose next deadline is either
 * already overdue (any number of days in the past) or coming up
 * within `withinDays` days. Overdue items have a negative daysAway
 * so callers (the email scheduler) can flag them distinctly.
 */
async function findUpcomingDeadlines(withinDays = 3) {
  const [grievancesRes, holidaysRes] = await Promise.all([
    query("select data from grievances"),
    query("select date, name from holidays")
  ]);
  const holidaySet = buildHolidaySet(holidaysRes.rows);
  const todayMid = todayInChicago();
  const results = [];
  for (const row of grievancesRes.rows) {
    const rec = row.data;
    if (isResolvedRec(rec)) continue;
    const nd = nextDeadlineServer(rec, holidaySet);
    if (!nd) continue;
    const diffDays = Math.round((nd.date - todayMid) / 86400000);
    // No lower bound — a deadline missed 80 days ago must still surface.
    // Upper bound still limits how far into the future we look.
    if (diffDays <= withinDays) {
      results.push({
        id: rec.id, employee: rec.employee, steward: rec.steward,
        stewardEmail: rec.stewardEmail, deadlineLabel: nd.label,
        deadlineDate: toISODate(nd.date), daysAway: diffDays
      });
    }
  }
  return results;
}

// User management
function normalizeUsername(u) { return String(u || "").trim().toLowerCase(); }

async function hasAnyUsers() {
  const res = await query("select 1 from users limit 1");
  return res.rows.length > 0;
}

async function listUsersSafe() {
  const res = await query(
    "select username, display_name, role, created_at from users order by created_at asc"
  );
  return res.rows.map(r => ({
    username: r.username, displayName: r.display_name, role: r.role || "steward",
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  }));
}

const VALID_ROLES = ["admin", "steward"];

async function upsertUser({ username, displayName, password, role }) {
  const uname = normalizeUsername(username);
  if (!uname) throw new Error("Username is required.");
  if (!displayName || !String(displayName).trim()) throw new Error("Display name is required.");
  let requestedRole = role && VALID_ROLES.includes(role) ? role : null;

  return withTransaction(async (client) => {
    const existing = await client.query(
      "select username, password_hash, role from users where username = $1", [uname]
    );
    const isNew = existing.rows.length === 0;

    if (isNew) {
      if (!password) throw new Error("A password is required for a new user.");
      const passwordHash = hashPassword(password);
      const countRes = await client.query("select count(*)::int as n from users");
      const isFirstEver = countRes.rows[0].n === 0;
      const finalRole = isFirstEver ? "admin" : (requestedRole || "steward");
      await client.query(
        `insert into users (username, display_name, password_hash, role, created_at) values ($1,$2,$3,$4,now())`,
        [uname, String(displayName).trim(), passwordHash, finalRole]
      );
      return { ok: true, isNew, role: finalRole };
    }

    const finalRole = requestedRole || existing.rows[0].role || "steward";
    if (existing.rows[0].role === "admin" && finalRole !== "admin") {
      const adminCountRes = await client.query(
        "select count(*)::int as n from users where role = 'admin'"
      );
      if (adminCountRes.rows[0].n <= 1)
        throw new Error(`Can't change "${uname}" to steward — they're the only admin account left.`);
    }

    if (password) {
      const passwordHash = hashPassword(password);
      await client.query(
        `update users set display_name=$2, password_hash=$3, role=$4 where username=$1`,
        [uname, String(displayName).trim(), passwordHash, finalRole]
      );
    } else {
      await client.query(
        `update users set display_name=$2, role=$3 where username=$1`,
        [uname, String(displayName).trim(), finalRole]
      );
    }
    return { ok: true, isNew, role: finalRole };
  });
}

async function deleteUser(username) {
  const uname = normalizeUsername(username);
  return withTransaction(async (client) => {
    const target = await client.query("select role from users where username=$1", [uname]);
    if (target.rows.length && target.rows[0].role === "admin") {
      const adminCountRes = await client.query(
        "select count(*)::int as n from users where role='admin'"
      );
      if (adminCountRes.rows[0].n <= 1)
        throw new Error(`Can't delete "${uname}" — they're the only admin account left.`);
    }
    await client.query("delete from users where username=$1", [uname]);
    return { ok: true };
  });
}

async function verifyLogin(username, password) {
  const uname = normalizeUsername(username);
  const res = await query(
    "select username, display_name, role, password_hash from users where username=$1", [uname]
  );
  if (res.rows.length === 0) return null;
  const user = res.rows[0];
  if (!verifyPassword(password, user.password_hash)) return null;
  return { username: user.username, displayName: user.display_name, role: user.role || "steward" };
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function createSession(username) {
  const uname = normalizeUsername(username);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await withTransaction(async (client) => {
    await client.query(
      "insert into sessions (token, username, expires_at) values ($1,$2,$3)",
      [token, uname, expiresAt]
    );
    await client.query("delete from sessions where expires_at < now()");
  });
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const res = await query(
    `select u.username, u.display_name, u.role
       from sessions s join users u on u.username=s.username
      where s.token=$1 and s.expires_at>now()`,
    [token]
  );
  if (res.rows.length === 0) return null;
  return {
    username: res.rows[0].username,
    displayName: res.rows[0].display_name,
    role: res.rows[0].role || "steward"
  };
}

async function destroySession(token) {
  await query("delete from sessions where token=$1", [token]);
  return { ok: true };
}

function withLock(fn) { return Promise.resolve().then(fn); }

/**
 * Records one email log entry — used both for the daily steward
 * deadline-reminder run and for individual grievant progress
 * notifications, so every real email attempt (success or failure)
 * leaves a small trace in the database. This also has the useful
 * side effect of keeping the database "active" with real writes,
 * which matters on hosting tiers (like Supabase's free tier) that
 * pause a database after a period of total inactivity.
 */
async function logEmailAttempt(entry) {
  await withTransaction(async (client) => {
    await client.query(
      "insert into email_log (data) values ($1::jsonb)",
      [JSON.stringify({ loggedAt: new Date().toISOString(), ...entry })]
    );
    await client.query(
      `delete from email_log where row_id not in
       (select row_id from email_log order by row_id desc limit 200)`
    );
  });
}

async function writeRawAtomic(data) {
  await withTransaction(async (client) => {
    if (typeof data.lastEmailRunDate === "string") {
      await client.query(
        `insert into app_meta (key,value) values ('lastEmailRunDate',$1)
         on conflict (key) do update set value=excluded.value`,
        [data.lastEmailRunDate]
      );
    }
    if (Array.isArray(data.emailLog) && data.emailLog.length) {
      await client.query(
        "insert into email_log (data) values ($1::jsonb)",
        [JSON.stringify(data.emailLog[0])]
      );
      await client.query(
        `delete from email_log where row_id not in
         (select row_id from email_log order by row_id desc limit 60)`
      );
    }
  });
}

module.exports = {
  getAll, readRaw, writeRawAtomic, withLock, logEmailAttempt,
  submitGrievance, logActivity, archiveClosed, sendCourtesyNotice,
  updateStewards, updateSetupList, updateHolidays, updateOrgSettings,
  findUpcomingDeadlines, SIMPLE_SETUP_KEYS,
  hasAnyUsers, listUsersSafe, upsertUser, deleteUser,
  verifyLogin, createSession, getSessionUser, destroySession
};
