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
  // Session tokens are deliberately never loaded here: this payload goes to
  // every logged-in user, and a token is a working login for whoever holds it.
  const [
    grievancesRes, activityRes, archiveRes, usersRes,
    holidaysRes, setupRes, emailLogRes, metaRes, attachmentsRows
  ] = await Promise.all([
    query("select data from grievances order by created_at asc"),
    query("select data from activity order by row_id asc"),
    query("select data from archive order by created_at asc"),
    query("select username, display_name, role, locations, email, is_steward, created_at from users"),
    query("select date, name from holidays order by date asc"),
    query("select key, items from setup_lists"),
    query("select data from email_log order by row_id desc limit 60"),
    query("select key, value from app_meta"),
    listAttachments()
  ]);

  const setup = {};
  for (const row of setupRes.rows) setup[row.key] = row.items || [];
  // The steward lists are read from the user records, so a person is only
  // ever edited in one place.
  const stewardRows = usersRes.rows.filter(r => r.is_steward)
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  setup.Steward = stewardRows.map(r => r.display_name);
  setup.StewardEmail = stewardRows.map(r => r.email || "");

  const users = usersRes.rows.map(r => ({
    username: r.username,
    displayName: r.display_name,
    role: r.role || "steward",
    locations: Array.isArray(r.locations) ? r.locations : [],
    email: r.email || "",
    isSteward: !!r.is_steward,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
    // NOTE: password_hash is deliberately NOT included here. This response
    // goes to every logged-in user regardless of role (unlike /api/users,
    // which is admin-gated) -- sending hashes here would let any steward
    // read every account's password hash straight out of the network tab.
  }));

  const metaMap = {};
  for (const row of metaRes.rows) metaMap[row.key] = row.value;

  return {
    grievances: grievancesRes.rows.map(r => r.data),
    activity:   activityRes.rows.map(r => r.data),
    archive:    archiveRes.rows.map(r => r.data),
    emailLog:   emailLogRes.rows.map(r => r.data),
    attachments: attachmentsRows,
    users,
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
    },
    locationDetails: (() => {
      try { return JSON.parse(metaMap.orgLocationDetails || "{}") || {}; } catch { return {}; }
    })(),
    grievancePool: (() => {
      try {
        const pool = JSON.parse(metaMap.grievanceNumberPool || '[]');
        return { remaining: Array.isArray(pool) ? pool.length : 0 };
      } catch { return { remaining: 0 }; }
    })()
  };
}

async function readRaw() { return getAll(); }

async function getGrievanceLocationById(id) {
  const res = await query("select data->>'location' as location from grievances where id = $1", [id]);
  return res.rows.length ? (res.rows[0].location || "") : null; // null = doesn't exist yet (a new grievance)
}

/** Returns { lockedTo, location } for an existing grievance, or null if not found. */
async function getGrievanceLock(id) {
  const res = await query(
    "select locked_to, data->>'location' as location, data->>'employee' as employee from grievances where id = $1",
    [id]
  );
  if (!res.rows.length) return null;
  return {
    lockedTo: res.rows[0].locked_to || null,
    location: res.rows[0].location || "",
    employee: res.rows[0].employee || ""
  };
}

/**
 * Transfers the lock on a grievance to another user.
 * Only the current lock holder or an admin may call this — the caller
 * must have already checked that before calling.
 * Returns { ok: true, lockedTo: newUsername }.
 */
async function handoffGrievance(id, toUsername) {
  if (!id || !toUsername) throw new Error("id and toUsername are required.");
  const res = await query(
    `update grievances set locked_to = $2, updated_at = now() where id = $1 returning locked_to`,
    [id, toUsername]
  );
  if (!res.rows.length) throw new Error(`Grievance ${id} not found.`);
  return { ok: true, lockedTo: res.rows[0].locked_to };
}

async function submitGrievance(record) {
  const id = String(record.id || "").trim();
  if (!id) throw new Error("Grievance ID is required.");

  return withTransaction(async (client) => {
    const existing = await client.query("select data, locked_to from grievances where id = $1", [id]);
    const isNew = existing.rows.length === 0;
    if (isNew) {
      // Never reuse an ID that already lives in the archive.
      const arch = await client.query("select 1 from archive where id = $1", [id]);
      if (arch.rows.length) throw new Error(`Grievance ID ${id} already exists in the archive.`);
    }
    const target = isNew ? { id } : { ...existing.rows[0].data };
    // Carry the existing lock forward (hand-offs update locked_to directly via
    // handoffGrievance — not through submitGrievance).
    const existingLockedTo = isNew ? null : (existing.rows[0].locked_to || null);

    // Capture "was this step already filed before this save?" BEFORE
    // we overwrite the date fields below, so the caller can tell which
    // steps were just newly filed in this specific save (used to decide
    // whether to send a grievant progress-notification email).
    const wasFiledBefore = {
      step1: !!target.step1filed,
      step2: !!target.step2filed,
      step3: !!target.step3filed
    };

    // Employee name is locked after first submission — only set on new records.
    if (isNew) target.employee = record.employee || "";
    // On updates, ignore any incoming employee value to prevent accidental
    // or intentional renaming of the grievant after the case is filed.
    target.grievantEmail = record.grievantEmail || "";
    target.description  = record.description  || "";
    target.jobClass     = record.jobClass     || "";
    target.bu           = record.bu           || "";
    target.location     = record.location     || target.location || "";
    target.steward      = record.steward      || "";
    target.stewardEmail = record.stewardEmail || "";
    target.gtype        = record.gtype        || "";
    target.article      = record.article      || "";
    target.section      = record.section      || "";
    target.remedy       = record.remedy       || "";
    target.status       = record.status       || "Pending";

    // A date key that is present but blank means the steward cleared it, so
    // clear it. A key that is absent means the caller didn't mention that
    // date, so the stored value stays. (The intake form always sends every
    // date field, so a cleared field really does arrive as blank.)
    for (const field of DATE_FIELDS) {
      if (!(field in record)) continue;
      target[field] = record[field] || "";
    }

    target.createdAt = target.createdAt || record.createdAt || new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    target.createdBy = target.createdBy || record.actingUser || "";
    target.updatedBy = record.actingUser || "";
    target.id = id;

    // Edit history: append a coarse entry on every save.
    // New grievances get a "Created" entry; subsequent saves get "Edited".
    // Kept inside the data blob so it travels with the record (archive, export).
    const historyEntry = {
      at: target.updatedAt,
      by: record.actingUser || record.actorUsername || "unknown",
      action: isNew ? "Created" : "Edited"
    };
    target.editHistory = [...(Array.isArray(target.editHistory) ? target.editHistory : []), historyEntry];

    // Lock: new grievances are locked to the creating user's username.
    // Existing grievances keep their current lock (only handoffGrievance changes it).
    // We store the username (not display name) for stable identity comparison.
    const newLockedTo = isNew
      ? (record.actorUsername || record.actingUser || null)
      : existingLockedTo;
    // Mirror into data blob so the client can read it without a separate query
    target.lockedTo = newLockedTo || "";

    await client.query(
      `insert into grievances (id, status, steward, locked_to, data, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, now())
       on conflict (id) do update
         set status = excluded.status, steward = excluded.steward,
             locked_to = excluded.locked_to,
             data = excluded.data, updated_at = now()`,
      [id, target.status, target.steward, newLockedTo, JSON.stringify(target)]
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

// How long an in-progress courtesy-notice claim is honoured before it is
// treated as abandoned (the process died mid-send).
const COURTESY_CLAIM_TTL_MS = 2 * 60 * 1000;

/** A short, random pause before a compare-and-swap retry, so writers that
 *  collided don't all retry in lockstep and collide again. */
function casBackoff(attempt) {
  const ms = Math.min(50, 2 + attempt * 3) * (0.5 + Math.random());
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Changes one grievance's JSON data without ever overwriting someone else's
 * concurrent change to it. Reads the record, lets `mutate` compute the new
 * version, and writes it only if the record is still exactly what was read
 * (compare-and-swap on the JSON); if it changed in between, it re-reads and
 * tries again.
 *
 * `mutate` gets a copy of the current data and returns the new data, or
 * null/undefined to leave the record alone. Returns { changed, data }.
 */
async function updateGrievanceData(gid, mutate, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cur = await query("select data from grievances where id = $1", [gid]);
    if (cur.rows.length === 0) throw new Error(`Grievance ${gid} not found.`);
    const before = cur.rows[0].data;
    const after = mutate({ ...before });
    if (after === null || after === undefined) return { changed: false, data: before };
    const res = await query(
      `update grievances set data = $3::jsonb, updated_at = now()
        where id = $1 and data = $2::jsonb
        returning id`,
      [gid, JSON.stringify(before), JSON.stringify(after)]
    );
    if (res.rows.length) return { changed: true, data: after };
    await casBackoff(attempt);
  }
  throw new Error(`Could not update grievance ${gid} because it kept changing. Please try again.`);
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
/**
 * Splits a comma-separated email list into clean, validated addresses.
 * Kept as a small local copy (rather than importing from
 * grievantNotify.js) to avoid a circular require, since
 * grievantNotify.js itself requires this file.
 */
function parseEmailList(raw) {
  return String(raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.includes("@"));
}

async function sendCourtesyNotice(gid, step) {
  if (step !== "step1" && step !== "step2") {
    throw new Error('Courtesy notices are only available for "step1" or "step2".');
  }

  const stepName = step === "step1" ? "Step 1" : "Step 2";
  const sentFlagKey = step === "step1" ? "step1CourtesySent" : "step2CourtesySent";
  const claimKey = step === "step1" ? "step1CourtesyClaimedAt" : "step2CourtesyClaimedAt";

  // NOTE: deliberately not wrapped in one transaction. Sending email takes
  // seconds; holding a database connection open for that long (and then
  // writing back a copy of the record that was read before the send) would
  // overwrite any edit a steward saved in the meantime.
  const existing = await query("select data from grievances where id = $1", [gid]);
  if (existing.rows.length === 0) throw new Error(`Grievance ${gid} not found.`);
  const rec = existing.rows[0].data;

  if (rec[sentFlagKey]) {
    throw new Error(`A courtesy notice for ${stepName} has already been sent for this grievance.`);
  }

  const metaRes = await query("select key, value from app_meta");
  const metaMap = {};
  for (const row of metaRes.rows) metaMap[row.key] = row.value;
  const recipients = (() => {
    // Prefer the per-location management email if one is configured for
    // this grievance's location -- falls back to the org-wide email so
    // existing setups without per-location config still work.
    let locationEmail = "";
    try {
      const detailsRes = metaRes.rows.find(r => r.key === "orgLocationDetails");
      const details = detailsRes ? JSON.parse(detailsRes.value || "{}") : {};
      const loc = rec && rec.location;
      if (loc && details[loc] && details[loc].email) {
        locationEmail = details[loc].email;
      }
    } catch { /* fall through */ }
    return parseEmailList(locationEmail || metaMap.orgManagementEmail || "");
  })();
  if (recipients.length === 0) {
    throw new Error("No management contact email is set. Go to Settings → Local chapter info to add one.");
  }

  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
  if (!apiKey || !senderEmail) {
    throw new Error("Email is not configured (BREVO_API_KEY / BREVO_SENDER_EMAIL). See server/mailer.js for setup steps.");
  }

  const holidaysRes = await query("select date, name from holidays");
  const holidaySet = buildHolidaySet(holidaysRes.rows);
  const d = deriveDeadlinesServer(rec, holidaySet);
  const dueDate = step === "step1" ? d.step1Due : d.step2AnswerDue;
  if (!dueDate) {
    throw new Error(`No ${step === "step1" ? "Step 1 response" : "Step 2 answer"} deadline could be calculated yet for this grievance.`);
  }
  const dueDateISO = toISODate(dueDate);

  // Claim this step before sending: only a caller that actually writes the
  // claim may send. Without this, two simultaneous clicks both passed the
  // "already sent?" check above and both emailed management, breaking the
  // one-time guarantee. A claim older than COURTESY_CLAIM_TTL_MS is treated
  // as abandoned (the server died mid-send) so a crash can't block the
  // notice forever.
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - COURTESY_CLAIM_TTL_MS).toISOString();
  let blockedBy = null;
  const claim = await updateGrievanceData(gid, (data) => {
    if (data[sentFlagKey]) { blockedBy = "sent"; return null; }
    if (data[claimKey] && data[claimKey] >= staleBefore) { blockedBy = "sending"; return null; }
    blockedBy = null;
    return { ...data, [claimKey]: claimedAt };
  });
  if (!claim.changed) {
    if (blockedBy === "sent") {
      throw new Error(`A courtesy notice for ${stepName} has already been sent for this grievance.`);
    }
    throw new Error(`A courtesy notice for ${stepName} is already being sent for this grievance. Give it a moment, then check the grievance again.`);
  }

  // From here on the claim must be released (or replaced by the "sent" flag)
  // no matter how we leave.
  let finished = false;
  try {
    const stepLabel = step === "step1" ? "Step 1 (Oral Grievance)" : "Step 2 (Written Grievance)";
    const localNo = await getOrgLocalNo().catch(() => "");
    const localTag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
    const subject = `[${localTag}] Courtesy Reminder: ${stepLabel} response due ${dueDateISO} — Grievance ${gid}`;
    const text = [
      `This is a courtesy reminder regarding Grievance ${gid} (${rec.employee || ""}).`,
      "",
      `${localTag} — FCRC Grievance Tracker`,
      "",
      `A response at ${stepLabel} is due by ${dueDateISO} under the Master Agreement.`,
      "",
      "This notice is sent as a courtesy and does not waive or extend any contractual deadline.",
      "",
      `— ${localTag} | FCRC${rec.steward ? ", " + rec.steward : ""}`
    ].join("\n");

    const { sendMail, GRIEVANCE_SENDER_NAME } = require("./mailer");

    // Send to every configured management recipient. A courtesy notice
    // is a paper-trail action, so we send to each address independently
    // rather than failing the whole thing if one address has a problem —
    // but we still need to know if ANY of them actually went out.
    const sendResults = [];
    for (const to of recipients) {
      try {
        await sendMail({ apiKey, senderEmail, senderName: GRIEVANCE_SENDER_NAME, to, subject, text });
        sendResults.push({ to, ok: true });
        await logEmailAttempt({
          kind: "management-courtesy-notice", gid, step, to, ok: true
        }).catch(logErr => console.error("[db] Failed to write email log entry:", logErr.message));
      } catch (err) {
        const detail = err && (err.message || err.code || err.name) || String(err);
        sendResults.push({ to, ok: false, error: detail });
        await logEmailAttempt({
          kind: "management-courtesy-notice", gid, step, to, ok: false, error: detail
        }).catch(logErr => console.error("[db] Failed to write email log entry:", logErr.message));
      }
    }

    const anySucceeded = sendResults.some(r => r.ok);
    if (!anySucceeded) {
      const firstError = sendResults[0] && sendResults[0].error;
      throw new Error(`Could not send the courtesy notice to any recipient. ${firstError || ""}`.trim());
    }

    // Record "sent" by changing only our own keys on the CURRENT record, not
    // by writing back the copy read before the send: a steward may have saved
    // an edit, or the other step's notice may have finished, while the
    // emails were going out.
    const sentAtIso = new Date().toISOString();
    const done = await updateGrievanceData(gid, (data) => {
      const next = { ...data, [sentFlagKey]: true, [`${step}CourtesySentAt`]: sentAtIso };
      delete next[claimKey];
      return next;
    });
    const updated = done.data;
    finished = true;

    const failedCount = sendResults.filter(r => !r.ok).length;
    return {
      ok: true,
      deadlineDate: dueDateISO,
      record: updated,
      sentTo: sendResults.filter(r => r.ok).map(r => r.to),
      failedTo: sendResults.filter(r => !r.ok).map(r => r.to),
      partialFailure: failedCount > 0
    };
  } finally {
    if (!finished) {
      // Nothing went out, so let the steward try again.
      try {
        await updateGrievanceData(gid, (data) => {
          if (data[claimKey] !== claimedAt) return null; // not ours any more
          const released = { ...data };
          delete released[claimKey];
          return released;
        });
      } catch (releaseErr) {
        console.error("[db] Failed to release courtesy-notice claim:", releaseErr.message);
      }
    }
  }
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

/**
 * @param {string[]|null} allowedLocations  null = admin (no location filter)
 * @param {string|null}   actorUsername     username of the caller; used for lock check (null = admin bypass)
 */
async function archiveClosed(allowedLocations, actorUsername) {
  return withTransaction(async (client) => {
    const archivedAt = chicagoDateISO(new Date());
    const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 1}`).join(", ");
    // allowedLocations === null means "no location restriction" (admin caller).
    // A steward/steward_plus caller passes their own assigned locations so
    // this only ever touches grievances they could already see and act on.
    const locationClause = allowedLocations
      ? ` and data->>'location' = any($${TERMINAL_STATUSES.length + 1})`
      : "";
    const params = allowedLocations ? [...TERMINAL_STATUSES, allowedLocations] : TERMINAL_STATUSES;
    const res = await client.query(
      `select id, status, steward, locked_to, data from grievances where status in (${placeholders})${locationClause}`,
      params
    );
    // Never overwrite an archived case that shares an ID with a live one
    // (that would silently destroy the archived record) -- leave it live
    // and report it instead.
    const idsInArchive = new Set();
    if (res.rows.length) {
      const dup = await client.query("select id from archive where id = any($1)", [res.rows.map(r => r.id)]);
      for (const r of dup.rows) idsInArchive.add(r.id);
    }
    const toArchive = [];
    const skippedDuplicates = [];
    for (const row of res.rows) {
      // Lock check: non-admins can only archive grievances locked to themselves.
      // actorUsername === null means admin caller — admins bypass the lock.
      if (actorUsername !== null && row.locked_to && row.locked_to !== actorUsername) continue;
      if (idsInArchive.has(row.id)) { skippedDuplicates.push(row.id); continue; }
      toArchive.push(row);
    }
    // Delete from the live table first, then insert into the archive, so the
    // ID is only ever in one table (the DB trigger enforces this too).
    if (toArchive.length) {
      await client.query(`delete from grievances where id = any($1)`, [toArchive.map(r => r.id)]);
    }
    let archivedCount = 0;
    for (const row of toArchive) {
      const archivedRecord = { ...row.data, archivedAt };
      await client.query(
        `insert into archive (id, status, steward, archived_at, data)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [row.id, row.status, row.steward, archivedAt, JSON.stringify(archivedRecord)]
      );
      archivedCount++;
    }
    return { archivedCount, skippedDuplicates };
  });
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

/** Fetch a single setup list (e.g. "Article", "GrievanceType") straight from
 *  the DB, without pulling the whole app payload. Used by the grievance-draft
 *  bot so it always picks from this local's real, current dropdown options
 *  rather than trusting whatever the browser happened to have cached. */
async function getSetupList(key) {
  const res = await query("select items from setup_lists where key = $1", [key]);
  return (res.rows[0] && res.rows[0].items) || [];
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

/** Reads the AFSCME Local number from org settings for use in email
 *  subjects and bodies. Returns a string like "2858", or "" if not set. */
async function getOrgLocalNo() {
  const res = await query("select value from app_meta where key = 'orgLocalNo'");
  return (res.rows[0] && res.rows[0].value) ? res.rows[0].value.trim() : "";
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

/**
 * Per-location bureau and management email configuration.
 * Stored as a single JSON blob in app_meta under the key "orgLocationDetails".
 * Shape: { "Location Name": { bureau: "...", email: "..." }, ... }
 *
 * This lets each FCRC office have its own bureau/program unit label and
 * management contact(s) for courtesy reminder emails, without needing a
 * new DB table -- the existing app_meta key-value store handles it fine
 * since this is a small, rarely-updated config blob.
 */
async function getLocationDetails() {
  const res = await query("select value from app_meta where key = 'orgLocationDetails'");
  if (!res.rows.length) return {};
  try { return JSON.parse(res.rows[0].value) || {}; } catch { return {}; }
}

async function updateLocationDetails(details) {
  if (typeof details !== "object" || Array.isArray(details)) throw new Error("details must be an object");
  const clean = {};
  for (const [loc, cfg] of Object.entries(details)) {
    const l = String(loc).trim();
    if (!l) continue;
    clean[l] = {
      bureau: String((cfg && cfg.bureau) || "").trim(),
      email:  String((cfg && cfg.email)  || "").trim()
    };
  }
  await query(
    `insert into app_meta (key, value) values ('orgLocationDetails', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(clean)]
  );
  return { ok: true, details: clean };
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
  // Once Step 2 is filed the grievance has advanced, so the Step 1 response
  // deadline no longer applies (it used to stay overdue forever).
  if (d.step1Due       && !rec.step1resp && !rec.step2filed) candidates.push({ date: d.step1Due,       label: "Step 1 response due" });
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

/** The Chicago calendar date (YYYY-MM-DD) for an instant, matching todayInChicago. */
function chicagoDateISO(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(instant);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeName(n) { return String(n || "").trim().toLowerCase().replace(/\s+/g, " "); }

/**
 * Finds every non-resolved grievance whose next deadline is either
 * already overdue (any number of days in the past) or coming up
 * within `withinDays` days. Overdue items have a negative daysAway
 * so callers (the email scheduler) can flag them distinctly.
 */
async function findUpcomingDeadlines(withinDays = 3) {
  const [grievancesRes, holidaysRes, usersRes] = await Promise.all([
    query("select data from grievances"),
    query("select date, name from holidays"),
    query("select display_name, email, is_steward from users where email <> ''")
  ]);
  const holidaySet = buildHolidaySet(holidaysRes.rows);
  // Reminders go to the email on the steward's current user record (matched
  // by name), so an email changed in Manage users applies to open grievances
  // too. Stewards are preferred over other accounts with the same name.
  const emailByName = new Map();
  for (const u of usersRes.rows.sort((a, b) => Number(b.is_steward) - Number(a.is_steward))) {
    const key = normalizeName(u.display_name);
    if (key && !emailByName.has(key)) emailByName.set(key, String(u.email).trim());
  }
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
      // Fall back to the address saved on the grievance if no user matches.
      const currentEmail = emailByName.get(normalizeName(rec.steward));
      results.push({
        id: rec.id, employee: rec.employee, steward: rec.steward,
        stewardEmail: currentEmail || rec.stewardEmail || "", deadlineLabel: nd.label,
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
    "select username, display_name, role, locations, email, is_steward, created_at from users order by created_at asc"
  );
  return res.rows.map(r => ({
    username: r.username, displayName: r.display_name, role: r.role || "steward",
    locations: Array.isArray(r.locations) ? r.locations : [],
    email: r.email || "",
    isSteward: !!r.is_steward,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  }));
}

const VALID_ROLES = ["admin", "steward_plus", "steward", "read_only"];

async function upsertUser({ username, displayName, password, role, locations, email, isSteward }) {
  const uname = normalizeUsername(username);
  if (!uname) throw new Error("Username is required.");
  if (!displayName || !String(displayName).trim()) throw new Error("Display name is required.");
  const requestedRole = role && VALID_ROLES.includes(role) ? role : null;
  const cleanLocations = Array.isArray(locations)
    ? [...new Set(locations.map(l => String(l || "").trim()).filter(l => l !== ""))]
    : null; // null means "not provided" -- leave existing value alone on update
  const cleanEmail = email === undefined ? null : String(email || "").trim();
  const stewardFlag = isSteward === undefined ? null : !!isSteward;

  return withTransaction(async (client) => {
    const existing = await client.query(
      "select username, password_hash, role from users where username = $1", [uname]
    );
    const isNew = existing.rows.length === 0;

    if (isNew) {
      // A steward with no login is stored with an empty password hash, which
      // verifyPassword never accepts.
      if (!password && !stewardFlag) throw new Error("A password is required for a new user, unless they are a steward with no login.");
      const passwordHash = password ? hashPassword(password) : "";
      const countRes = await client.query("select count(*)::int as n from users");
      const isFirstEver = countRes.rows[0].n === 0;
      const finalRole = isFirstEver ? "admin" : (requestedRole || "steward");
      await client.query(
        `insert into users (username, display_name, password_hash, role, locations, email, is_steward, created_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,now())`,
        [uname, String(displayName).trim(), passwordHash, finalRole,
         JSON.stringify(cleanLocations || []), cleanEmail || "", !!stewardFlag]
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

    // Only the fields the caller sent are changed; an omitted password keeps the current one.
    const sets = ["display_name = $2", "role = $3"];
    const params = [uname, String(displayName).trim(), finalRole];
    if (password) { params.push(hashPassword(password)); sets.push(`password_hash = $${params.length}`); }
    if (cleanLocations !== null) { params.push(JSON.stringify(cleanLocations)); sets.push(`locations = $${params.length}::jsonb`); }
    if (cleanEmail !== null) { params.push(cleanEmail); sets.push(`email = $${params.length}`); }
    if (stewardFlag !== null) { params.push(stewardFlag); sets.push(`is_steward = $${params.length}`); }
    await client.query(`update users set ${sets.join(", ")} where username = $1`, params);
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

// Hashed once at startup so a login for an unknown username costs the same
// scrypt time as a wrong password. Otherwise the faster "no such user" reply
// tells an attacker which usernames exist.
const UNKNOWN_USER_HASH = hashPassword("unknown-user-placeholder");

async function verifyLogin(username, password) {
  const uname = normalizeUsername(username);
  const res = await query(
    "select username, display_name, role, locations, password_hash from users where username=$1", [uname]
  );
  const plain = String(password == null ? "" : password);
  if (res.rows.length === 0) {
    verifyPassword(plain, UNKNOWN_USER_HASH);
    return null;
  }
  const user = res.rows[0];
  if (!verifyPassword(plain, user.password_hash)) return null;
  return {
    username: user.username, displayName: user.display_name, role: user.role || "steward",
    locations: Array.isArray(user.locations) ? user.locations : []
  };
}

// A session ends after 30 minutes with no user activity. expires_at is the
// idle deadline: it starts at login and is moved forward only by
// touchSession(), which the browser calls on real user input. Background
// polling never extends it, so an unattended open tab signs out.
const SESSION_IDLE_MS = 30 * 60 * 1000;

async function createSession(username) {
  const uname = normalizeUsername(username);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
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
    `select u.username, u.display_name, u.role, u.locations
       from sessions s join users u on u.username=s.username
      where s.token=$1 and s.expires_at>now()`,
    [token]
  );
  if (res.rows.length === 0) return null;
  return {
    username: res.rows[0].username,
    displayName: res.rows[0].display_name,
    role: res.rows[0].role || "steward",
    locations: Array.isArray(res.rows[0].locations) ? res.rows[0].locations : []
  };
}

/** Moves an active session's idle deadline to 30 minutes from now. An expired
 *  session is not revived. */
async function touchSession(token) {
  if (!token) return;
  await query(
    "update sessions set expires_at=$2 where token=$1 and expires_at>now()",
    [token, new Date(Date.now() + SESSION_IDLE_MS)]
  );
}

/** Signs a user out everywhere except the session in `keepToken`. */
async function deleteOtherSessions(username, keepToken) {
  await query("delete from sessions where username = $1 and token <> $2", [normalizeUsername(username), keepToken || ""]);
}

async function destroySession(token) {
  await query("delete from sessions where token=$1", [token]);
  return { ok: true };
}

/**
 * A real mutual-exclusion lock: callers run strictly one at a time, in the
 * order they asked. This used to just run `fn` immediately, so two requests
 * doing a read-modify-write on the same app_meta JSON (the grievance number
 * pool) both read the old value -- two stewards clicking "Assign next" at
 * once were handed the same number, and one add/log write silently
 * overwrote the other.
 *
 * It is per process. That is enough here because the app runs as a single
 * instance; the unique-ID triggers on grievances/archive remain the
 * database-level backstop if that ever changes.
 */
let lockTail = Promise.resolve();
function withLock(fn) {
  const run = lockTail.then(fn);
  // A failing fn must not wedge everyone queued behind it.
  lockTail = run.catch(() => {});
  return run;
}

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

// ---------- Shared contact link (union members give their own details) ----------
// One link for the whole local is emailed to employees. It is not personal: no
// name is attached. Each person chooses their location from the existing list.
// The link is valid for 30 days, or until a steward revokes it. Creating a new
// link replaces the old one. Only a SHA-256 hash of the token is stored.
const CONTACT_LINK_TTL_MS = 30 * 24 * 3600 * 1000;

function hashContactToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function isValidContactEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidContactPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits[0] === "1");
}

/** The locations people can choose from: the existing location list. */
async function getLocationList() {
  const res = await query("select items from setup_lists where key = 'Location'");
  const items = res.rows.length ? res.rows[0].items : [];
  return Array.isArray(items) ? items.map(x => String(x)).filter(Boolean) : [];
}

/** Creates the shared link. Any active link is revoked first. Returns the raw token. */
async function createContactLink(createdBy) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CONTACT_LINK_TTL_MS);
  await withTransaction(async (client) => {
    await client.query("update contact_links set revoked_at = now() where revoked_at is null and expires_at > now()");
    await client.query(
      "insert into contact_links (token_hash, created_by, expires_at) values ($1,$2,$3)",
      [hashContactToken(token), String(createdBy || ""), expiresAt]
    );
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Checks a token. Returns null if the link does not exist. */
async function getContactLink(token) {
  const res = await query("select expires_at, revoked_at from contact_links where token_hash = $1", [hashContactToken(token)]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { isExpired: new Date(r.expires_at) < new Date(), isRevoked: !!r.revoked_at };
}

// Shared by both save paths. A ticked newsletter box opts the person in and
// clears any earlier unsubscribe. An unticked box records "not opted in", but
// keeps a permanent unsubscribe in place.
const NEWSLETTER_UPDATE_SQL = `update contact_submissions
    set location = $2, legal_name = $3, phone = $4, personal_email = $5, state_email = $6,
        consent_at = now(), submitted_at = now(),
        newsletter_opt_in = $7,
        newsletter_opt_in_at = case when $7 then now() else newsletter_opt_in_at end,
        newsletter_unsubscribed_at = case when $7 then null else newsletter_unsubscribed_at end
  where id = $1`;

/** Saves one person's details. Validation happens before anything is saved.
 *  Required: a location from the list, legal name, consent, and at least one
 *  way to reach them (phone or an email). Any email given is checked. */
async function submitContact(token, input) {
  const location = String((input && input.location) || "").trim();
  const legalName = String((input && input.legalName) || "").trim().replace(/\s+/g, " ");
  const phone = String((input && input.phone) || "").trim();
  const personalEmail = String((input && input.personalEmail) || "").trim();
  const stateEmail = String((input && input.stateEmail) || "").trim();
  const newsletter = !!(input && input.newsletter === true);
  if (!input || input.consent !== true) throw new Error("Please tick the box to agree to how your details will be used.");
  if (!location) throw new Error("Please choose your location.");
  if (!(await getLocationList()).includes(location)) throw new Error("Please choose your location from the list.");
  if (legalName.length < 2 || legalName.length > 120) throw new Error("Please enter your legal name.");
  if (!phone && !personalEmail && !stateEmail) throw new Error("Please enter a phone number or at least one email address.");
  if (phone && !isValidContactPhone(phone)) throw new Error("That phone number does not look right. Please include the 10-digit number.");
  if (personalEmail && !isValidContactEmail(personalEmail)) throw new Error("That personal email address does not look right.");
  if (stateEmail && !isValidContactEmail(stateEmail)) throw new Error("That state email address does not look right.");

  const link = await query(
    "select 1 from contact_links where token_hash = $1 and revoked_at is null and expires_at > now()",
    [hashContactToken(token)]
  );
  if (!link.rows.length) throw new Error("This link has expired or been replaced. Ask your steward for the current link.");

  // The same person may submit again (after a timeout, or to correct a detail).
  // They count as the same person only if the legal name matches AND a phone or
  // an email matches. A shared phone or email alone is not enough, so one
  // person's entry is never overwritten by someone else's.
  const digits = (phone.match(/\d/g) || []).join("").slice(-10);
  const nameKey = legalName.toLowerCase();
  const existing = await query("select id, legal_name, phone, personal_email, state_email from contact_submissions");
  const match = existing.rows.find(r =>
    String(r.legal_name || "").trim().replace(/\s+/g, " ").toLowerCase() === nameKey && (
      (digits && (r.phone.match(/\d/g) || []).join("").slice(-10) === digits) ||
      (personalEmail && r.personal_email.toLowerCase() === personalEmail.toLowerCase()) ||
      (stateEmail && r.state_email.toLowerCase() === stateEmail.toLowerCase())
    )
  );
  if (match) {
    await query(NEWSLETTER_UPDATE_SQL, [match.id, location, legalName, phone, personalEmail, stateEmail, newsletter]);
    return { ok: true, updated: true };
  }
  await query(
    `insert into contact_submissions (id, location, legal_name, phone, personal_email, state_email,
                                      newsletter_opt_in, newsletter_opt_in_at, unsubscribe_token)
     values ($1, $2, $3, $4, $5, $6, $7, case when $7 then now() else null end, $8)`,
    [crypto.randomBytes(12).toString("hex"), location, legalName, phone, personalEmail, stateEmail,
     newsletter, crypto.randomBytes(16).toString("hex")]
  );
  return { ok: true };
}

/** Everything stewards need: the submissions (newest first) and whether a link is live. */
async function listContacts() {
  const [subs, link] = await Promise.all([
    query("select id, location, legal_name, phone, personal_email, state_email, submitted_at, newsletter_opt_in, newsletter_unsubscribed_at from contact_submissions order by submitted_at desc, id"),
    query("select max(expires_at) as expires_at from contact_links where revoked_at is null and expires_at > now()")
  ]);
  const expires = link.rows[0] && link.rows[0].expires_at;
  return {
    submissions: subs.rows.map(r => ({
      id: r.id,
      location: r.location,
      legalName: r.legal_name,
      phone: r.phone,
      personalEmail: r.personal_email,
      stateEmail: r.state_email,
      submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      newsletterOptIn: !!r.newsletter_opt_in && !r.newsletter_unsubscribed_at,
      newsletterUnsubscribed: !!r.newsletter_unsubscribed_at && !r.newsletter_opt_in
    })),
    activeLink: expires ? { expiresAt: new Date(expires).toISOString() } : null
  };
}

/** A staff correction to one entry. Same checks as the forms. Staff can turn newsletters
 *  off for someone, which counts as an unsubscribe. Staff cannot turn them back on for a
 *  person who unsubscribed: only that person can opt back in. Returns the fields changed. */
async function updateContactSubmission(id, input) {
  const key = String(id || "").trim();
  if (!key) throw new Error("Entry id is required.");
  const cur = await query("select * from contact_submissions where id = $1", [key]);
  if (!cur.rows.length) throw new Error("That entry no longer exists.");
  const old = cur.rows[0];
  const v = input || {};
  const location = String(v.location || "").trim();
  const legalName = String(v.legalName || "").trim().replace(/\s+/g, " ");
  const phone = String(v.phone || "").trim();
  const personalEmail = String(v.personalEmail || "").trim();
  const stateEmail = String(v.stateEmail || "").trim();
  const newsletter = v.newsletter === true;
  if (!(await getLocationList()).includes(location)) throw new Error("Choose a location from the list.");
  if (legalName.length < 2 || legalName.length > 120) throw new Error("Enter the legal name.");
  if (!phone && !personalEmail && !stateEmail) throw new Error("Enter a phone number or at least one email address.");
  if (phone && !isValidContactPhone(phone)) throw new Error("That phone number does not look right.");
  if (personalEmail && !isValidContactEmail(personalEmail)) throw new Error("That personal email address does not look right.");
  if (stateEmail && !isValidContactEmail(stateEmail)) throw new Error("That state email address does not look right.");
  if (newsletter && !old.newsletter_opt_in && old.newsletter_unsubscribed_at) {
    throw new Error("This person unsubscribed from newsletters. Only they can opt back in, using their update form.");
  }

  const changed = [];
  if (old.location !== location) changed.push("location");
  if (old.legal_name !== legalName) changed.push("legal name");
  if (old.phone !== phone) changed.push("phone");
  if (old.personal_email !== personalEmail) changed.push("personal email");
  if (old.state_email !== stateEmail) changed.push("state email");
  if (!!old.newsletter_opt_in !== newsletter) changed.push("newsletter");

  // Turning newsletters off by staff is recorded as an unsubscribe.
  const stoppingNewsletter = !!old.newsletter_opt_in && !newsletter;
  await query(
    `update contact_submissions
        set location = $2, legal_name = $3, phone = $4, personal_email = $5, state_email = $6,
            newsletter_opt_in = $7,
            newsletter_opt_in_at = case when $7 and not newsletter_opt_in then now() else newsletter_opt_in_at end,
            newsletter_unsubscribed_at = case when $8 then now() else newsletter_unsubscribed_at end
      where id = $1`,
    [key, location, legalName, phone, personalEmail, stateEmail, newsletter, stoppingNewsletter]
  );
  return { ok: true, changed };
}

async function revokeContactLink() {
  await query("update contact_links set revoked_at = now() where revoked_at is null");
  return { ok: true };
}

/** Removes one person's submission (for example, when someone asks for their details to be deleted). */
async function removeContactSubmission(id) {
  const key = String(id || "").trim();
  if (!key) throw new Error("Submission id is required.");
  await query("delete from contact_submissions where id = $1", [key]);
  return { ok: true };
}

// ---------- Update links: a person changes their own entry ----------
// A steward sends a one-time link to the person's personal email on file. The
// link opens a blank form for that one entry, so it shows no existing details.
const CONTACT_UPDATE_TTL_MS = 72 * 3600 * 1000;

async function getSubmissionRow(id) {
  const res = await query(
    "select id, location, legal_name, phone, personal_email, state_email from contact_submissions where id = $1",
    [String(id || "")]
  );
  return res.rows[0] || null;
}

/** Creates a link for one entry. Any earlier link for that entry stops working. */
async function createContactUpdateLink(submissionId, createdBy) {
  const sub = await getSubmissionRow(submissionId);
  if (!sub) throw new Error("That entry no longer exists.");
  if (!sub.personal_email) throw new Error("This person has no personal email on file, so a link cannot be sent. Ask them to use the contact link instead.");
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CONTACT_UPDATE_TTL_MS);
  await withTransaction(async (client) => {
    await client.query(
      "update contact_update_links set expires_at = now() where submission_id = $1 and used_at is null and expires_at > now()",
      [sub.id]
    );
    await client.query(
      "insert into contact_update_links (token_hash, submission_id, sent_to, created_by, expires_at) values ($1,$2,$3,$4,$5)",
      [hashContactToken(token), sub.id, sub.personal_email, String(createdBy || ""), expiresAt]
    );
  });
  return { token, sentTo: sub.personal_email, legalName: sub.legal_name, expiresAt: expiresAt.toISOString() };
}

/** Stops a link that could not be delivered, so it cannot be used. */
async function expireContactUpdateLink(token) {
  await query("update contact_update_links set expires_at = now() where token_hash = $1", [hashContactToken(token)]);
}

async function getContactUpdateLink(token) {
  const res = await query(
    "select submission_id, expires_at, used_at from contact_update_links where token_hash = $1",
    [hashContactToken(token)]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { submissionId: r.submission_id, isExpired: new Date(r.expires_at) < new Date(), isUsed: !!r.used_at };
}

/** Saves a person's changes to their own entry. Same checks as the sign-up form.
 *  Returns the old and new personal email, so the caller can send a confirmation. */
async function submitContactUpdate(token, input) {
  const location = String((input && input.location) || "").trim();
  const legalName = String((input && input.legalName) || "").trim().replace(/\s+/g, " ");
  const phone = String((input && input.phone) || "").trim();
  const personalEmail = String((input && input.personalEmail) || "").trim();
  const stateEmail = String((input && input.stateEmail) || "").trim();
  const newsletter = !!(input && input.newsletter === true);
  if (!input || input.consent !== true) throw new Error("Please tick the box to agree to how your details will be used.");
  if (!location) throw new Error("Please choose your location.");
  if (!(await getLocationList()).includes(location)) throw new Error("Please choose your location from the list.");
  if (legalName.length < 2 || legalName.length > 120) throw new Error("Please enter your legal name.");
  if (!phone && !personalEmail && !stateEmail) throw new Error("Please enter a phone number or at least one email address.");
  if (phone && !isValidContactPhone(phone)) throw new Error("That phone number does not look right. Please include the 10-digit number.");
  if (personalEmail && !isValidContactEmail(personalEmail)) throw new Error("That personal email address does not look right.");
  if (stateEmail && !isValidContactEmail(stateEmail)) throw new Error("That state email address does not look right.");

  const claim = await query(
    "update contact_update_links set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning submission_id",
    [hashContactToken(token)]
  );
  if (!claim.rows.length) throw new Error("This link has expired or has already been used. Ask your steward for a new one.");
  const submissionId = claim.rows[0].submission_id;

  const before = await getSubmissionRow(submissionId);
  if (!before) throw new Error("That entry no longer exists. Ask your steward for help.");
  try {
    await query(NEWSLETTER_UPDATE_SQL, [submissionId, location, legalName, phone, personalEmail, stateEmail, newsletter]);
  } catch (err) {
    await query("update contact_update_links set used_at = null where token_hash = $1", [hashContactToken(token)])
      .catch(releaseErr => console.error("[db] Failed to release update link:", releaseErr.message));
    throw err;
  }
  const oldEmail = (before.personal_email || "").trim();
  return { ok: true, legalName, newPersonalEmail: personalEmail, emailChanged: !!personalEmail && personalEmail.toLowerCase() !== oldEmail.toLowerCase() };
}

// ---------- Newsletter ----------
// Recipients are people who opted in, have not unsubscribed, and have an address of
// the chosen type. A newsletter record is kept for one year.

/** People who should receive a newsletter now. */
async function getNewsletterRecipients({ location, addressType }) {
  const col = addressType === "state" ? "state_email" : "personal_email";
  const params = [];
  let where = `newsletter_opt_in = true and newsletter_unsubscribed_at is null and ${col} <> ''`;
  if (location) {
    params.push(location);
    where += ` and location = $${params.length}`;
  }
  const res = await query(
    `select id, location, legal_name, ${col} as email, unsubscribe_token
       from contact_submissions where ${where} order by legal_name`,
    params
  );
  return res.rows.map(r => ({
    id: r.id, location: r.location, legalName: r.legal_name, email: r.email, unsubscribeToken: r.unsubscribe_token
  }));
}

/** People who get a union business notice: anyone who gave a state email. Newsletter
 *  opt-in does not apply, and there is no unsubscribe for notices. */
async function getNoticeRecipients({ location }) {
  const params = [];
  let where = `state_email <> ''`;
  if (location) {
    params.push(location);
    where += ` and location = $${params.length}`;
  }
  const res = await query(
    `select id, location, legal_name, state_email as email from contact_submissions where ${where} order by legal_name`,
    params
  );
  return res.rows.map(r => ({ id: r.id, location: r.location, legalName: r.legal_name, email: r.email }));
}

/** Unsubscribes the person who holds this token. Permanent, unless they tick the box again. */
async function unsubscribeByToken(token) {
  const key = String(token || "");
  if (!key) return false;
  const res = await query(
    `update contact_submissions set newsletter_opt_in = false, newsletter_unsubscribed_at = now()
      where unsubscribe_token = $1 returning id`,
    [key]
  );
  return res.rows.length > 0;
}

async function createNewsletterRecord(n) {
  const id = crypto.randomBytes(10).toString("hex");
  await query(
    `insert into newsletters (id, subject, body, audience, location, address_type, reason, sent_by, recipients, status, kind)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sending',$10)`,
    [id, n.subject, n.body, n.audience, n.location || "", n.addressType, n.reason || "", n.sentBy || "", n.recipients || 0, n.kind || "newsletter"]
  );
  return id;
}

async function updateNewsletterProgress(id, sent, failed) {
  await query("update newsletters set sent = $2, failed = $3 where id = $1", [id, sent, failed]);
}

async function finishNewsletterRecord(id, sent, failed) {
  await query(
    "update newsletters set sent = $2, failed = $3, status = 'sent', finished_at = now() where id = $1",
    [id, sent, failed]
  );
}

async function listNewsletterRecords(username, admin) {
  const res = await query(
    `select id, subject, audience, location, address_type, reason, sent_by, created_at, finished_at, recipients, sent, failed, status, kind
       from newsletters ${admin ? "" : "where sent_by = $1"} order by created_at desc limit 100`,
    admin ? [] : [String(username || "")]
  );
  return res.rows.map(r => ({
    id: r.id, subject: r.subject, audience: r.audience, location: r.location, addressType: r.address_type,
    kind: r.kind, reason: r.reason, sentBy: r.sent_by,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    recipients: r.recipients, sent: r.sent, failed: r.failed, status: r.status
  }));
}

/** Removes newsletter records older than one year. */
async function purgeOldNewsletters() {
  await query("delete from newsletters where created_at < now() - interval '365 days'");
}

/** Newest-first email log entries, for the admin Email log. */
async function getEmailLog(limit = 200) {
  const res = await query("select data from email_log order by row_id desc limit $1", [limit]);
  return res.rows.map(r => r.data);
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

/**
 * Per-day bookkeeping for the steward reminder run: which addresses were
 * already emailed today and how many automatic attempts have been made.
 * Lets a retry after a partial failure email only the people who were
 * missed, instead of re-sending to everyone who already got theirs.
 */
/** The date (YYYY-MM-DD, Chicago) of the last finished reminder run, or "". */
async function getLastEmailRunDate() {
  const res = await query("select value from app_meta where key = 'lastEmailRunDate'");
  return (res.rows[0] && res.rows[0].value) || "";
}

async function getEmailRunState(today) {
  const res = await query("select value from app_meta where key = 'emailRunState'");
  try {
    const s = JSON.parse((res.rows[0] && res.rows[0].value) || "{}");
    if (s && s.date === today) {
      return { date: today, attempts: Number(s.attempts) || 0, sentTo: Array.isArray(s.sentTo) ? s.sentTo : [] };
    }
  } catch { /* corrupt or missing -> start the day fresh */ }
  return { date: today, attempts: 0, sentTo: [] };
}

async function saveEmailRunState(state) {
  await query(
    `insert into app_meta (key, value) values ('emailRunState', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify({ date: state.date, attempts: state.attempts, sentTo: state.sentTo })]
  );
}

// ============================================================
// INVESTIGATION WORKFLOW
// ============================================================

const crypto_inv = require("crypto");

/** Generate the next sequential investigation ID (INV-YYYY-NNNN). */
async function nextInvestigationId() {
  const year = new Date().getFullYear();
  const res = await query(
    `insert into app_meta (key, value) values ('investigationSeq_${year}', '1')
     on conflict (key) do update set value = (cast(app_meta.value as int) + 1)::text
     returning value`
  );
  const seq = String(res.rows[0].value).padStart(4, "0");
  return `INV-${year}-${seq}`;
}

async function createInvestigation({ location, steward, employee, contactEmail, actingUser }) {
  const id = await nextInvestigationId();
  const now = new Date().toISOString();
  const data = {
    id, location: location || "", steward: steward || "", status: "open",
    createdAt: now, createdBy: actingUser || steward || "",
    employee: employee || "", contactEmail: contactEmail || "", contactPhone: "",
    incidentDescription: "", incidentDates: "",
    closeReason: null, closeNotes: "", convertedGrievanceId: null,
    logbook: [], witnessStatements: [], grievantSubmission: null
  };
  await query(
    "insert into investigations (id, data, created_at) values ($1, $2::jsonb, now())",
    [id, JSON.stringify(data)]
  );
  return data;
}

async function getInvestigation(id) {
  const res = await query("select data from investigations where id = $1", [id]);
  return res.rows.length ? res.rows[0].data : null;
}

async function getAllInvestigations() {
  const res = await query("select data from investigations order by created_at desc");
  return res.rows.map(r => r.data);
}

/**
 * Changes only the given fields of an investigation. It re-reads the record
 * and writes only if nothing changed in between (compare-and-swap), retrying
 * otherwise. A plain read-then-write here used to let a concurrent update
 * (e.g. a grievant's submission arriving while a steward logs an entry) be
 * silently overwritten by a copy read before it landed.
 */
async function updateInvestigation(id, patch, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await query("select data from investigations where id = $1", [id]);
    if (!res.rows.length) throw new Error(`Investigation ${id} not found.`);
    const current = res.rows[0].data;
    // `patch` may be a function of the freshly read record, so a change that
    // depends on the current contents (like appending to the logbook) is built
    // from what is actually stored, not from an earlier read.
    const delta = typeof patch === "function" ? patch(current) : patch;
    const merged = Object.assign({}, current, delta, { id }); // id is immutable
    const written = await query(
      "update investigations set data = $3::jsonb where id = $1 and data = $2::jsonb returning id",
      [id, JSON.stringify(current), JSON.stringify(merged)]
    );
    if (written.rows.length) return merged;
    await casBackoff(attempt);
  }
  throw new Error(`Investigation ${id} is being changed by someone else. Please try again.`);
}

async function addInvestigationLogEntry(id, { date, steward, entry }) {
  const inv = await getInvestigation(id);
  if (!inv) throw new Error(`Investigation ${id} not found.`);
  if (inv.status !== "open") throw new Error("Investigation is closed — no new logbook entries.");
  const logEntry = {
    id: crypto_inv.randomBytes(6).toString("hex"),
    date: date || new Date().toISOString().slice(0, 10),
    steward: steward || "",
    entry: String(entry || "").trim(),
    createdAt: new Date().toISOString()
  };
  await updateInvestigation(id, (current) => {
    if (current.status !== "open") throw new Error("Investigation is closed — no new logbook entries.");
    return { logbook: [...(current.logbook || []), logEntry] };
  });
  return logEntry;
}

async function closeInvestigation(id, { reason, notes }) {
  const VALID_REASONS = ["no_violation", "resolved", "withdrew", "other"];
  if (!VALID_REASONS.includes(reason)) throw new Error(`Invalid close reason: ${reason}`);
  const inv = await getInvestigation(id);
  if (!inv) throw new Error(`Investigation ${id} not found.`);
  if (inv.status === "converted") {
    throw new Error(`This investigation became grievance ${inv.convertedGrievanceId}, so it can't be closed. Work the case from the grievance instead.`);
  }
  return updateInvestigation(id, {
    status: "closed",
    closeReason: reason,
    closeNotes: String(notes || "").trim(),
    closedAt: new Date().toISOString(),
    pendingGrievanceId: null
  });
}

/** Converts an investigation to a formal grievance. Returns the new grievance's
 *  pre-filled record so the caller can route the steward into the intake form. */
/**
 * Starts converting an investigation to a formal grievance. This only records
 * the grievance number that is pending and returns the pre-filled record. The
 * investigation becomes "converted" only once a grievance with that number is
 * actually saved (see linkGrievanceToInvestigation). Cancelling the intake
 * form therefore leaves the investigation open and convertible again.
 */
async function convertInvestigationToGrievance(id, grievanceId, actingUser) {
  const inv = await getInvestigation(id);
  if (!inv) throw new Error(`Investigation ${id} not found.`);
  if (inv.status === "converted") throw new Error("Already converted.");
  const gid = String(grievanceId || "").trim();
  if (!gid) throw new Error("Enter a grievance ID for the new grievance.");
  const taken = await query(
    "select 1 from grievances where id = $1 union all select 1 from archive where id = $1",
    [gid]
  );
  if (taken.rows.length) throw new Error(`Grievance ID ${gid} is already in use. Choose another.`);
  const sub = inv.grievantSubmission && inv.grievantSubmission.data;
  // Build a pre-filled grievance record from investigation data
  const pre = {
    id: gid,
    employee: sub ? (sub.name || inv.employee) : inv.employee,
    grievantEmail: sub ? (sub.email || inv.contactEmail) : inv.contactEmail,
    description: sub ? (sub.description || inv.incidentDescription) : inv.incidentDescription,
    location: inv.location,
    steward: inv.steward,
    status: "Pending",
    investigationId: id,
    actingUser: actingUser || inv.steward
  };
  await updateInvestigation(id, { pendingGrievanceId: gid });
  return pre;
}

/**
 * Marks an investigation converted, once the grievance it was pending for has
 * really been saved. Does nothing unless that exact grievance number is the
 * pending one, so a stray save can't convert the wrong investigation.
 */
async function linkGrievanceToInvestigation(investigationId, gid) {
  const inv = await getInvestigation(investigationId);
  if (!inv || inv.status === "converted" || inv.pendingGrievanceId !== gid) return false;
  await updateInvestigation(investigationId, {
    status: "converted",
    convertedGrievanceId: gid,
    convertedAt: new Date().toISOString(),
    pendingGrievanceId: null
  });
  return true;
}

/** Creates a public-facing token for the grievant intake form or a witness statement.
 *  Tokens expire after 7 days. Each investigation gets at most one active grievant
 *  token (re-issuing replaces old ones); witness tokens are unlimited. */
async function createInvestigationToken(investigationId, type, witnessName) {
  if (!["grievant", "witness"].includes(type)) throw new Error("Invalid token type.");
  const inv = await getInvestigation(investigationId);
  if (!inv) throw new Error(`Investigation ${investigationId} not found.`);

  if (type === "grievant") {
    // Expire any existing, unused grievant token for this investigation
    await query(
      `update investigation_tokens set expires_at = now()
       where investigation_id = $1 and type = 'grievant' and submitted_at is null`,
      [investigationId]
    );
    // If there's already a submitted grievant form, don't allow a second one
    if (inv.grievantSubmission) throw new Error("The grievant has already submitted their intake form for this investigation.");
  }

  const token = crypto_inv.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await query(
    `insert into investigation_tokens (token, investigation_id, type, witness_name, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [token, investigationId, type, witnessName || null, expiresAt]
  );
  return { token, expiresAt };
}

/** Looks up a token and returns the token row + its investigation (or null if invalid/expired/used). */
async function getInvestigationByToken(token) {
  const res = await query(
    `select t.token, t.investigation_id, t.type, t.witness_name,
            t.expires_at, t.submitted_at, i.data
     from investigation_tokens t
     join investigations i on i.id = t.investigation_id
     where t.token = $1`,
    [token]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  const isExpired = new Date(row.expires_at) < new Date();
  const isUsed = !!row.submitted_at;
  return { tokenRow: row, investigation: row.data, isExpired, isUsed };
}

/** Marks a token as used and writes the submission into the investigation record. */
async function submitInvestigationForm(token, formData) {
  const found = await getInvestigationByToken(token);
  if (!found) throw new Error("Invalid or expired link.");
  if (found.isExpired) throw new Error("This link has expired — ask the steward to send a new one.");
  if (found.isUsed) throw new Error("This form has already been submitted.");

  const { tokenRow, investigation } = found;
  if (tokenRow.type !== "grievant") throw new Error("Unknown token type.");

  // Claim the link in one conditional write. Two people submitting at the same
  // moment both passed the checks above; only the claim that actually lands may
  // continue, so the second submission can no longer overwrite the first.
  const claim = await query(
    `update investigation_tokens set submitted_at = now()
      where token = $1 and submitted_at is null and expires_at > now()
      returning token`,
    [token]
  );
  if (!claim.rows.length) throw new Error("This form has already been submitted.");

  try {
    await updateInvestigation(investigation.id, {
      grievantSubmission: { submittedAt: new Date().toISOString(), data: formData }
    });
  } catch (err) {
    // The statement wasn't saved, so free the link for another attempt.
    await query("update investigation_tokens set submitted_at = null where token = $1", [token])
      .catch(releaseErr => console.error("[db] Failed to release form link:", releaseErr.message));
    throw err;
  }

  return { ok: true };
}

async function archiveInvestigation(id) {
  const inv = await getInvestigation(id);
  if (!inv) throw new Error(`Investigation ${id} not found.`);
  if (inv.status === "open") throw new Error("Cannot archive an open investigation — close or convert it first.");
  return updateInvestigation(id, { archived: true, archivedAt: new Date().toISOString() });
}

async function unarchiveInvestigation(id) {
  const inv = await getInvestigation(id);
  if (!inv) throw new Error(`Investigation ${id} not found.`);
  return updateInvestigation(id, { archived: false, archivedAt: null });
}

/**
 * Writes a tiny timestamp into app_meta. Called on every successful
 * login and on every session check (fire-and-forget, never blocks or
 * fails the caller) so the database sees a real write on a predictable,
 * frequent trigger -- not just whenever a steward happens to touch a
 * grievance. Supabase's free tier auto-pauses a project after 7 days
 * with no database activity; a single active user opening the app
 * periodically is enough to keep that from ever happening, without
 * needing a paid plan or an external cron/uptime-ping service.
 *
 * Throttled in-memory to at most one actual write per hour -- a session
 * check fires on every single page load, and with several stewards
 * using the app there's no need for each of those to be its own write.
 * The in-memory throttle is fine even though Render can restart the
 * process, since a restart itself means the app is actively being used
 * anyway (and Render's free tier only ever runs one instance).
 */
let lastKeepAlivePingAt = 0;
const KEEP_ALIVE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
async function pingKeepAlive() {
  const now = Date.now();
  if (now - lastKeepAlivePingAt < KEEP_ALIVE_THROTTLE_MS) return;
  lastKeepAlivePingAt = now;
  await query(
    `insert into app_meta (key, value) values ('lastKeepAlivePing', $1)
     on conflict (key) do update set value = excluded.value`,
    [new Date().toISOString()]
  );
}

/**
 * File attachments per grievance. Actual bytes live in Supabase Storage
 * (see server/storage.js) -- this table only tracks metadata and a
 * pointer to the stored object, so getAll() can list what's attached
 * to each grievance without pulling any file content into memory.
 */
async function listAttachments() {
  let res;
  try {
    res = await query(
      `select id, gid, filename, content_type, size_bytes, uploaded_by, uploaded_at
       from attachments order by uploaded_at asc`
    );
  } catch (err) {
    // Postgres error code 42P01 = "relation does not exist" -- this means
    // migration 009 hasn't been run. Attachments are an optional feature;
    // the rest of the app must keep working fine without it, so this
    // returns an empty list instead of taking down every page load.
    if (err.code === "42P01") return [];
    throw err;
  }
  return res.rows.map(r => ({
    id: r.id,
    gid: r.gid,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : r.uploaded_at
  }));
}

async function createAttachmentRecord({ gid, filename, contentType, sizeBytes, storagePath, uploadedBy }) {
  const id = crypto.randomUUID();
  await query(
    `insert into attachments (id, gid, filename, content_type, size_bytes, storage_path, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, gid, filename, contentType, sizeBytes, storagePath, uploadedBy]
  );
  return { id, gid, filename, contentType, sizeBytes, uploadedBy, uploadedAt: new Date().toISOString() };
}

async function getAttachmentRecord(id) {
  const res = await query(`select * from attachments where id = $1`, [id]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    id: r.id, gid: r.gid, filename: r.filename, contentType: r.content_type,
    sizeBytes: r.size_bytes, storagePath: r.storage_path, uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : r.uploaded_at
  };
}

async function deleteAttachmentRecord(id) {
  await query(`delete from attachments where id = $1`, [id]);
}

/* -----------------------------------------------------------------------
 * Grievance Number Pool
 * -----------------------------------------------------------------------
 * The union president pre-assigns batches of grievance IDs (e.g. "FCRC-2026-001").
 * Admins paste them into Settings; intake form auto-assigns the next one.
 * Storage: two keys in app_meta --
 *   grievanceNumberPool  : JSON array of remaining (unused) numbers, FIFO
 *   grievanceNumberPoolLog: JSON array of {number, assignedBy, assignedAt}
 * There is ONE shared pool for all locations.
 * ----------------------------------------------------------------------- */

/** Returns the current pool state: { pool: string[], log: object[] } */
async function getGrievanceNumberPool() {
  const res = await query(
    `select key, value from app_meta where key in ('grievanceNumberPool','grievanceNumberPoolLog')`
  );
  const map = {};
  for (const row of res.rows) map[row.key] = row.value;
  let pool = [];
  let log  = [];
  try { pool = JSON.parse(map.grievanceNumberPool  || '[]'); } catch {}
  try { log  = JSON.parse(map.grievanceNumberPoolLog || '[]'); } catch {}
  return { pool, log };
}

/** Admin adds numbers to the pool. Duplicates are silently skipped.
 *  Checks against: pool queue, pool assignment log, live grievances, and archive. */
async function addToGrievanceNumberPool(numbers, addedBy) {
  return withLock(async () => {
    const { pool, log } = await getGrievanceNumberPool();
    const usedSet = new Set(log.map(e => e.number));
    const poolSet = new Set(pool);

    // Also exclude IDs already present in live grievances or archive
    const [liveRes, archiveRes] = await Promise.all([
      query(`select id from grievances`),
      query(`select id from archive`)
    ]);
    for (const row of liveRes.rows)    usedSet.add(row.id);
    for (const row of archiveRes.rows) if (row.id) usedSet.add(row.id);

    const newOnes = numbers.filter(n => n && !poolSet.has(n) && !usedSet.has(n));
    const updated = [...pool, ...newOnes];
    await query(
      `insert into app_meta (key, value) values ('grievanceNumberPool', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(updated)]
    );
    return { added: newOnes.length, skipped: numbers.length - newOnes.length, remaining: updated.length };
  });
}

/** Removes all numbers from the pool (admin reset). */
async function clearGrievanceNumberPool() {
  return withLock(async () => {
    await query(
      `insert into app_meta (key, value) values ('grievanceNumberPool', '[]')
       on conflict (key) do update set value = excluded.value`
    );
    return { ok: true };
  });
}

/**
 * Returns a previously-consumed number back to the front of the pool.
 * Called when a steward clicks "Assign next" but then clears the form
 * or navigates away without saving the grievance.
 */
async function returnGrievanceNumber(number, { username = "", isAdmin = false } = {}) {
  if (!number || typeof number !== "string") return { ok: false };
  return withLock(async () => {
    // Don't return if it's already in use in the DB (edge case: submitted on another tab)
    const [liveRes, archiveRes] = await Promise.all([
      query(`select id from grievances where id = $1`, [number]),
      query(`select id from archive where id = $1`, [number])
    ]);
    if (liveRes.rows.length > 0 || archiveRes.rows.length > 0) {
      return { ok: false, reason: "already_used" };
    }
    const { pool, log } = await getGrievanceNumberPool();
    // Avoid duplicates in the pool
    if (pool.includes(number)) return { ok: true, reason: "already_in_pool" };
    // Only whoever currently holds a number (its most recent assignment) may
    // put it back. Otherwise anyone could return a number another steward is
    // in the middle of using, and it would be handed out a second time.
    // Admins may return any number, e.g. to clean up after a lost session.
    if (!isAdmin) {
      const lastAssignment = [...log].reverse().find(e => e.number === number);
      if (!lastAssignment || lastAssignment.assignedBy !== username) {
        return { ok: false, reason: "not_yours" };
      }
    }
    const newPool = [number, ...pool]; // put it back at the front
    await query(
      `insert into app_meta (key, value) values ('grievanceNumberPool', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(newPool)]
    );
    return { ok: true, remaining: newPool.length };
  });
}

/**
 * Takes the next number from the pool and records it in the log.
 * Returns { number: string } or { empty: true } if pool is exhausted.
 * Skips any number that already exists in live grievances or archive
 * (safety net against manual entries that happened after the pool was loaded).
 */
async function consumeNextGrievanceNumber(assignedBy) {
  return withLock(async () => {
    const { pool, log } = await getGrievanceNumberPool();
    if (pool.length === 0) return { empty: true };

    // Build set of already-used IDs from both live grievances and archive
    const [liveRes, archiveRes] = await Promise.all([
      query(`select id from grievances`),
      query(`select id from archive`)
    ]);
    const existingIds = new Set();
    for (const row of liveRes.rows)    existingIds.add(row.id);
    for (const row of archiveRes.rows) if (row.id) existingIds.add(row.id);

    // Walk the pool FIFO, skip any number already in the database
    let next = null;
    let rest = pool;
    while (rest.length > 0) {
      const [candidate, ...remaining] = rest;
      rest = remaining;
      if (!existingIds.has(candidate)) { next = candidate; break; }
      // Number already used — drop it silently (no point keeping it in pool)
    }

    // Persist whatever is left after skipping used numbers
    await query(
      `insert into app_meta (key, value) values ('grievanceNumberPool', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(rest)]
    );

    if (!next) return { empty: true };

    const newLog = [...log, { number: next, assignedBy, assignedAt: new Date().toISOString() }];
    await query(
      `insert into app_meta (key, value) values ('grievanceNumberPoolLog', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(newLog)]
    );
    return { number: next, remaining: rest.length };
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append one entry to the audit_log table.
 * Fire-and-forget safe — callers .catch() so a DB hiccup never blocks a login.
 * @param {string} username
 * @param {'login'|'logout'|'tab'|'record_open'} action
 * @param {string} detail   - tab name, grievance ID, etc.
 * @param {string} ip       - request IP (best-effort)
 */
async function writeAuditLog(username, action, detail = "", ip = "") {
  await query(
    `insert into audit_log (username, action, detail, ip) values ($1, $2, $3, $4)`,
    [String(username), String(action), String(detail).slice(0, 500), String(ip).slice(0, 100)]
  );
}

/**
 * Fetch recent audit entries for the admin UI.
 * @param {number} limit   max rows (default 200)
 * @param {string} [filterUsername]  if provided, restrict to that user
 */
async function getAuditLog(limit = 200, filterUsername = null, filterActions = []) {
  const where = [];
  const params = [];
  if (filterUsername) { params.push(filterUsername); where.push(`username = $${params.length}`); }
  if (Array.isArray(filterActions) && filterActions.length) {
    params.push(filterActions); where.push(`action = any($${params.length}::text[])`);
  }
  params.push(limit);
  const res = await query(
    `select id, username, action, detail, ip, created_at from audit_log
     ${where.length ? "where " + where.join(" and ") : ""}
     order by created_at desc limit $${params.length}`,
    params
  );
  return res.rows;
}

module.exports = {
  getAll, readRaw, writeRawAtomic, getEmailLog, createContactLink, getContactLink, getLocationList, submitContact, listContacts, revokeContactLink, removeContactSubmission, updateContactSubmission, createContactUpdateLink, expireContactUpdateLink, getContactUpdateLink, submitContactUpdate, getNewsletterRecipients, unsubscribeByToken, createNewsletterRecord, updateNewsletterProgress, finishNewsletterRecord, listNewsletterRecords, purgeOldNewsletters, getNoticeRecipients, withLock, logEmailAttempt, pingKeepAlive,
  getEmailRunState, saveEmailRunState, getLastEmailRunDate, linkGrievanceToInvestigation, deleteOtherSessions, chicagoDateISO,
  submitGrievance, logActivity, archiveClosed, sendCourtesyNotice,
  updateSetupList, getSetupList, updateHolidays, updateOrgSettings,
  getLocationDetails, updateLocationDetails, getOrgLocalNo,
  findUpcomingDeadlines, SIMPLE_SETUP_KEYS, getGrievanceLocationById, getGrievanceLock, handoffGrievance,
  hasAnyUsers, listUsersSafe, upsertUser, deleteUser,
  verifyLogin, createSession, getSessionUser, destroySession, touchSession,
  // Investigation workflow
  createInvestigation, getInvestigation, getAllInvestigations, updateInvestigation,
  addInvestigationLogEntry, closeInvestigation, convertInvestigationToGrievance,
  createInvestigationToken, getInvestigationByToken, submitInvestigationForm,
  archiveInvestigation, unarchiveInvestigation,
  // Attachments
  listAttachments, createAttachmentRecord, getAttachmentRecord, deleteAttachmentRecord,
  // Grievance number pool
  getGrievanceNumberPool, addToGrievanceNumberPool, clearGrievanceNumberPool, consumeNextGrievanceNumber, returnGrievanceNumber,
  // Audit log
  writeAuditLog, getAuditLog
};
