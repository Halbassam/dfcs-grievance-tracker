/**
 * ================================================================
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Database layer — Supabase Postgres.
 *
 * This module exports the exact same function names, signatures,
 * and return shapes as the original file-based server/db.js. Every
 * other file in this app (index.js, scheduler.js, public/index.html
 * via the API) calls these functions and has NO IDEA whether the
 * data underneath is a JSON file or a Postgres database — so none
 * of those files needed to change for this migration.
 *
 * Where the original kept "the whole JSON blob" as the unit of
 * read/write, this version assembles the equivalent shape on read
 * (getAll) from several tables, and writes to the specific table(s)
 * each operation actually touches.
 * ================================================================
 */

const { query, withTransaction, pool } = require("./pool");
const { hashPassword, verifyPassword } = require("./passwords");
const crypto = require("crypto");

// ================================================================
// Static defaults (used only for first-run seeding via the
// migration script / seed script — NOT used at request time).
// Kept here so SIMPLE_SETUP_KEYS and the holiday defaults still
// live in one place, same as before.
// ================================================================

const SIMPLE_SETUP_KEYS = [
  "Status", "Bureau", "Location", "County", "BargainingUnit",
  "JobClass", "Shift", "Article", "GrievanceType", "ActivityType"
];

const DATE_FIELDS = ["awareness","step1filed","step1resp","step2filed","step2resp","step3filed","step3resp","step4filed"];
const TERMINAL_STATUSES = ["Settled", "Denied", "Withdrawn", "Granted", "Partially Granted"];

// ================================================================
// getAll() — reassembles the full data blob the frontend expects
// from /api/data, in the same shape the old JSON file had.
// ================================================================

async function getAll() {
  const [
    grievancesRes,
    activityRes,
    archiveRes,
    usersRes,
    sessionsRes,
    holidaysRes,
    setupRes,
    emailLogRes,
    metaRes
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
  for (const row of setupRes.rows) {
    setup[row.key] = row.items || [];
  }

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
    activity: activityRes.rows.map(r => r.data),
    archive: archiveRes.rows.map(r => r.data),
    emailLog: emailLogRes.rows.map(r => r.data),
    users,
    sessions,
    lastEmailRunDate: metaMap.lastEmailRunDate || "",
    holidays: holidaysRes.rows.map(r => ({ date: r.date, name: r.name })),
    setup
  };
}

/**
 * Low-level "give me the raw shape" accessor. The old file-based
 * version had readRaw() return the literal on-disk object — this
 * version is functionally identical to getAll() now that there's
 * no separate raw-vs-public distinction at the storage layer. Kept
 * as a separate export because scheduler.js and index.js both call
 * db.readRaw() directly.
 */
async function readRaw() {
  return getAll();
}

// ================================================================
// GRIEVANCES
// ================================================================

async function submitGrievance(record) {
  const id = String(record.id || "").trim();
  if (!id) throw new Error("Grievance ID is required.");

  return withTransaction(async (client) => {
    const existing = await client.query("select data from grievances where id = $1", [id]);
    const isNew = existing.rows.length === 0;
    const target = isNew ? { id } : { ...existing.rows[0].data };

    // Static metadata — always overwrite (matches original behavior)
    target.employee = record.employee || "";
    target.jobClass = record.jobClass || "";
    target.bu = record.bu || "";
    target.shift = record.shift || "";
    target.bureau = record.bureau || "";
    target.location = record.location || "";
    target.county = record.county || "";
    target.steward = record.steward || "";
    target.stewardEmail = record.stewardEmail || "";
    target.gtype = record.gtype || "";
    target.article = record.article || "";
    target.section = record.section || "";
    target.remedy = record.remedy || "";
    target.status = record.status || "Pending";

    // Date fields — only overwrite if incoming value is non-blank,
    // exactly like the original (preserves historic step dates).
    for (const field of DATE_FIELDS) {
      const incoming = record[field];
      if (incoming) {
        target[field] = incoming;
      }
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
         set status = excluded.status,
             steward = excluded.steward,
             data = excluded.data,
             updated_at = now()`,
      [id, target.status, target.steward, JSON.stringify(target)]
    );

    return { isNew, record: { ...target } };
  });
}

async function logActivity(record) {
  const entry = {
    id: record.id,
    gid: record.gid,
    date: record.date,
    type: record.type,
    steward: record.steward,
    step: record.step,
    notes: record.notes,
    followup: record.followup || "No",
    followupDate: record.followupDate || "",
    enteredBy: record.actingUser || ""
  };

  await query(
    "insert into activity (gid, data) values ($1, $2::jsonb)",
    [record.gid, JSON.stringify(entry)]
  );

  return { ok: true };
}

async function archiveClosed() {
  return withTransaction(async (client) => {
    const archivedAt = new Date().toISOString().slice(0, 10);

    // Use an explicit parameterized IN(...) list rather than = any($1::text[]).
    // TERMINAL_STATUSES is a small fixed list, so this is no less safe and
    // avoids relying on array-typed parameter binding across drivers/engines.
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
           set status = excluded.status,
               steward = excluded.steward,
               archived_at = excluded.archived_at,
               data = excluded.data`,
        [row.id, row.status, row.steward, archivedAt, JSON.stringify(archivedRecord)]
      );
      archivedCount++;
    }

    if (res.rows.length) {
      await client.query(
        `delete from grievances where status in (${placeholders})`,
        TERMINAL_STATUSES
      );
    }

    return { archivedCount };
  });
}

// ================================================================
// SETUP / DROPDOWN LIST MANAGEMENT
// ================================================================

async function updateStewards(stewards, emails) {
  if (!Array.isArray(stewards) || !Array.isArray(emails)) {
    throw new Error("Stewards and emails must both be arrays.");
  }
  if (stewards.length !== emails.length) {
    throw new Error("Steward names and emails must be the same length.");
  }
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
  if (!SIMPLE_SETUP_KEYS.includes(key)) {
    throw new Error(`Unknown or unsupported setup list: ${key}`);
  }
  if (!Array.isArray(items)) {
    throw new Error("Items must be an array.");
  }
  const cleanItems = items.map(s => String(s || "").trim()).filter(s => s !== "");

  await query(
    `insert into setup_lists (key, items) values ($1, $2::jsonb)
     on conflict (key) do update set items = excluded.items`,
    [key, JSON.stringify(cleanItems)]
  );

  return { ok: true, count: cleanItems.length };
}

// ================================================================
// HOLIDAY LIST MANAGEMENT
// ================================================================

function isValidISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

async function updateHolidays(holidays) {
  if (!Array.isArray(holidays)) {
    throw new Error("Holidays must be an array.");
  }
  const clean = holidays
    .map(h => ({
      date: String((h && h.date) || "").trim(),
      name: String((h && h.name) || "").trim()
    }))
    .filter(h => isValidISODate(h.date) && h.name !== "");

  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  await withTransaction(async (client) => {
    await client.query("delete from holidays");
    for (const h of clean) {
      await client.query(
        "insert into holidays (date, name) values ($1, $2)",
        [h.date, h.name]
      );
    }
  });

  return { ok: true, count: clean.length };
}

// ================================================================
// SERVER-SIDE WORKING-DAY / DEADLINE LOGIC
//
// Pure functions — identical to the original. No storage
// dependency, so nothing here needed to change. Kept duplicated
// from public/index.html for the same reason as before: the
// browser version has no build step, and the email job runs with
// no browser involved at all. Keep both in sync if deadline rules
// ever change.
// ================================================================

function toDateLocal(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISODate(d) {
  if (!d) return "";
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}
function buildHolidaySet(holidays) {
  return new Set((holidays || []).map(h => h.date));
}
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

const TERMINAL_STATUSES_FOR_DEADLINES = ["Settled", "Granted", "Denied", "Withdrawn", "Partially Granted"];

function deriveDeadlinesServer(rec, holidaySet) {
  const d = {};

  d.step1Due = rec.step1filed ? workday(rec.step1filed, 10, holidaySet) : null;

  let step2FilingBasis = null;
  if (rec.step1resp) {
    step2FilingBasis = rec.step1resp;
  } else if (d.step1Due) {
    step2FilingBasis = toISODate(d.step1Due);
  }
  d.step2FilingDue = step2FilingBasis ? workday(step2FilingBasis, 5, holidaySet) : null;

  d.step2MeetingDue = rec.step2filed ? workday(rec.step2filed, 10, holidaySet) : null;
  d.step2AnswerDue = d.step2MeetingDue ? workday(toISODate(d.step2MeetingDue), 5, holidaySet) : null;

  let step3FilingBasis = null;
  if (rec.step2resp) {
    step3FilingBasis = rec.step2resp;
  } else if (d.step2AnswerDue) {
    step3FilingBasis = toISODate(d.step2AnswerDue);
  }
  d.step3FilingDue = step3FilingBasis ? workday(step3FilingBasis, 15, holidaySet) : null;

  d.step3SignDue = rec.step3filed ? workday(rec.step3filed, 10, holidaySet) : null;

  let step4FilingBasis = null;
  if (rec.step3resp) {
    step4FilingBasis = rec.step3resp;
  } else if (d.step3SignDue) {
    step4FilingBasis = toISODate(d.step3SignDue);
  }
  d.step4FilingDue = step4FilingBasis ? workday(step4FilingBasis, 15, holidaySet) : null;

  d.arbHearingDue = rec.step4filed ? addCalendarDays(rec.step4filed, 60) : null;
  return d;
}

function isResolvedRec(rec) {
  return TERMINAL_STATUSES_FOR_DEADLINES.includes(rec.status);
}

function nextDeadlineServer(rec, holidaySet) {
  if (isResolvedRec(rec)) return null;
  const d = deriveDeadlinesServer(rec, holidaySet);
  const candidates = [];
  if (d.step1Due && !rec.step1resp) candidates.push({ date: d.step1Due, label: "Step 1 response" });
  if (d.step2AnswerDue && !rec.step2resp) candidates.push({ date: d.step2AnswerDue, label: "Step 2 answer" });
  if (d.step3SignDue && !rec.step3resp) candidates.push({ date: d.step3SignDue, label: "Step 3 sign-off" });
  if (d.arbHearingDue && !rec.arbResult) candidates.push({ date: d.arbHearingDue, label: "Arbitration hearing" });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.date < b.date ? a : b));
}

/**
 * Scans every active grievance and returns the ones with a next
 * deadline landing within `withinDays` days from today (inclusive).
 * Same signature as before. NOTE: still async-compatible at the
 * call sites (they don't await it in the original either, since it
 * was synchronous there) — but now it touches the database, so it
 * must be awaited. Both call sites (index.js, scheduler.js) already
 * call this and either return its result via a sendJson(await ...)
 * pattern or consume it directly; see migration notes for the one
 * line each needed an `await` added.
 */
async function findUpcomingDeadlines(withinDays = 3) {
  const [grievancesRes, holidaysRes] = await Promise.all([
    query("select data from grievances"),
    query("select date, name from holidays")
  ]);

  const holidaySet = buildHolidaySet(holidaysRes.rows);
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const results = [];
  for (const row of grievancesRes.rows) {
    const rec = row.data;
    if (isResolvedRec(rec)) continue;
    const nd = nextDeadlineServer(rec, holidaySet);
    if (!nd) continue;
    const diffDays = Math.round((nd.date - todayMid) / 86400000);
    if (diffDays >= 0 && diffDays <= withinDays) {
      results.push({
        id: rec.id,
        employee: rec.employee,
        steward: rec.steward,
        stewardEmail: rec.stewardEmail,
        deadlineLabel: nd.label,
        deadlineDate: toISODate(nd.date),
        daysAway: diffDays
      });
    }
  }
  return results;
}

// ================================================================
// USER ACCOUNT MANAGEMENT
// ================================================================

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

/**
 * Cheap existence check used on every request by index.js's
 * getCurrentUser() to decide whether the app is still in "open
 * access" mode (no accounts created yet). Avoids pulling the
 * entire dataset (getAll()) just to check one boolean — the
 * original file-based version could afford getAll() for this
 * because it was reading an in-memory/cached object; here that
 * would mean ~9 queries on every single request.
 */
async function hasAnyUsers() {
  const res = await query("select 1 from users limit 1");
  return res.rows.length > 0;
}

async function listUsersSafe() {
  const res = await query(
    "select username, display_name, role, created_at from users order by created_at asc"
  );
  return res.rows.map(r => ({
    username: r.username,
    displayName: r.display_name,
    role: r.role || "steward",
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
    const existing = await client.query("select username, password_hash, role from users where username = $1", [uname]);
    const isNew = existing.rows.length === 0;

    if (isNew) {
      if (!password) throw new Error("A password is required for a new user.");
      const passwordHash = hashPassword(password);

      // The very first account ever created has no one to grant it admin
      // access, so it's automatically promoted to admin. Every account
      // after that defaults to 'steward' unless an admin explicitly
      // picks 'admin' when creating it.
      const countRes = await client.query("select count(*)::int as n from users");
      const isFirstEver = countRes.rows[0].n === 0;
      const finalRole = isFirstEver ? "admin" : (requestedRole || "steward");

      await client.query(
        `insert into users (username, display_name, password_hash, role, created_at)
         values ($1, $2, $3, $4, now())`,
        [uname, String(displayName).trim(), passwordHash, finalRole]
      );
      return { ok: true, isNew, role: finalRole };
    }

    const finalRole = requestedRole || existing.rows[0].role || "steward";

    // Safety guard: never allow the last remaining admin to be demoted
    // to steward — that would lock everyone out of user management,
    // holiday/list editing, etc. with no way back in short of direct
    // database access.
    if (existing.rows[0].role === "admin" && finalRole !== "admin") {
      const adminCountRes = await client.query(
        "select count(*)::int as n from users where role = 'admin'"
      );
      if (adminCountRes.rows[0].n <= 1) {
        throw new Error(
          `Can't change "${uname}" to steward — they're the only admin account left. Promote someone else to admin first.`
        );
      }
    }

    if (password) {
      const passwordHash = hashPassword(password);
      await client.query(
        `update users set display_name = $2, password_hash = $3, role = $4 where username = $1`,
        [uname, String(displayName).trim(), passwordHash, finalRole]
      );
    } else {
      await client.query(
        `update users set display_name = $2, role = $3 where username = $1`,
        [uname, String(displayName).trim(), finalRole]
      );
    }

    return { ok: true, isNew, role: finalRole };
  });
}

async function deleteUser(username) {
  const uname = normalizeUsername(username);

  return withTransaction(async (client) => {
    const target = await client.query("select role from users where username = $1", [uname]);
    if (target.rows.length && target.rows[0].role === "admin") {
      const adminCountRes = await client.query("select count(*)::int as n from users where role = 'admin'");
      if (adminCountRes.rows[0].n <= 1) {
        throw new Error(`Can't delete "${uname}" — they're the only admin account left. Promote someone else to admin first.`);
      }
    }
    await client.query("delete from users where username = $1", [uname]); // sessions cascade via FK
    return { ok: true };
  });
}

async function verifyLogin(username, password) {
  const uname = normalizeUsername(username);
  const res = await query("select username, display_name, role, password_hash from users where username = $1", [uname]);
  if (res.rows.length === 0) return null;
  const user = res.rows[0];
  if (!verifyPassword(password, user.password_hash)) return null;
  return { username: user.username, displayName: user.display_name, role: user.role || "steward" };
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sessions last 30 days

async function createSession(username) {
  const uname = normalizeUsername(username);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await withTransaction(async (client) => {
    await client.query(
      "insert into sessions (token, username, expires_at) values ($1, $2, $3)",
      [token, uname, expiresAt]
    );
    // Opportunistic cleanup of expired sessions, same as the original.
    await client.query("delete from sessions where expires_at < now()");
  });

  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const res = await query(
    `select u.username, u.display_name, u.role
       from sessions s
       join users u on u.username = s.username
      where s.token = $1 and s.expires_at > now()`,
    [token]
  );
  if (res.rows.length === 0) return null;
  return { username: res.rows[0].username, displayName: res.rows[0].display_name, role: res.rows[0].role || "steward" };
}

async function destroySession(token) {
  await query("delete from sessions where token = $1", [token]);
  return { ok: true };
}

// ================================================================
// withLock — kept as a no-op-compatible shim.
//
// The original used withLock() to serialize JSON read/modify/write
// cycles within a single process. Postgres handles concurrent
// writes safely on its own, and every multi-statement operation
// above already uses withTransaction() for atomicity instead. This
// shim exists only so any code we haven't touched (or future code)
// that calls db.withLock(fn) keeps working without a crash — it
// just runs fn() directly.
// ================================================================
function withLock(fn) {
  return Promise.resolve().then(fn);
}

/**
 * Writes a full data object back "raw" — used historically for
 * direct mutations of the whole blob (e.g. scheduler.js recording
 * an email run). Re-implemented here to write only the pieces that
 * actually changed (lastEmailRunDate + emailLog), since those are
 * the only two fields any caller in this codebase ever mutates via
 * writeRawAtomic(). See scheduler.js for the one call site.
 */
async function writeRawAtomic(data) {
  await withTransaction(async (client) => {
    if (typeof data.lastEmailRunDate === "string") {
      await client.query(
        `insert into app_meta (key, value) values ('lastEmailRunDate', $1)
         on conflict (key) do update set value = excluded.value`,
        [data.lastEmailRunDate]
      );
    }
    if (Array.isArray(data.emailLog) && data.emailLog.length) {
      // Only the newest entry needs inserting — scheduler.js always
      // unshifts one new entry onto a copy of the existing log before
      // calling this, so the newest entry is index 0.
      const newest = data.emailLog[0];
      await client.query(
        "insert into email_log (data) values ($1::jsonb)",
        [JSON.stringify(newest)]
      );
      // Trim to the most recent 60, matching the old in-memory slice(0, 60).
      await client.query(
        `delete from email_log where row_id not in (
           select row_id from email_log order by row_id desc limit 60
         )`
      );
    }
  });
}

module.exports = {
  getAll,
  submitGrievance,
  logActivity,
  archiveClosed,
  updateStewards,
  updateSetupList,
  updateHolidays,
  findUpcomingDeadlines,
  readRaw,
  writeRawAtomic,
  withLock,
  SIMPLE_SETUP_KEYS,
  hasAnyUsers,
  listUsersSafe,
  upsertUser,
  deleteUser,
  verifyLogin,
  createSession,
  getSessionUser,
  destroySession
};
