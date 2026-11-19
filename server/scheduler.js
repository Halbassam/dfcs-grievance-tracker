/**
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Daily deadline email scheduler.
 * Sends reminder emails to stewards for grievances with deadlines
 * coming up within REMINDER_WINDOW_DAYS days.
 * No reminders are sent after Step 3 — Council 31 staff track Step 4.
 */

const db = require("./db");
const { sendMail } = require("./mailer");

const REMINDER_WINDOW_DAYS = 3;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

/**
 * Returns today's date as YYYY-MM-DD in America/Chicago (the FCRC's
 * local timezone), not the server's own clock. Render runs on UTC,
 * so anything checked in the evening Central time could otherwise
 * be misdated as tomorrow.
 */
function todayISO() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function buildEmailBody(stewardName, items, localNo) {
  const localTag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
  const overdue = items.filter(i => i.daysAway < 0).sort((a, b) => a.daysAway - b.daysAway);
  const upcoming = items.filter(i => i.daysAway >= 0).sort((a, b) => a.daysAway - b.daysAway);

  const lines = [];
  lines.push(`Dear ${stewardName},`);
  lines.push("");

  if (overdue.length) {
    lines.push(`\u26A0 ${overdue.length} grievance deadline(s) are PAST DUE:`);
    lines.push("");
    for (const item of overdue) {
      const daysLate = Math.abs(item.daysAway);
      lines.push(`  - Grievance ${item.id} (${item.employee})`);
      lines.push(`    OVERDUE: ${item.deadlineLabel} was due ${item.deadlineDate} — ${daysLate} day${daysLate === 1 ? "" : "s"} ago`);
      lines.push("");
    }
  }

  if (upcoming.length) {
    lines.push(`The following grievance deadline(s) are coming up within the next ${REMINDER_WINDOW_DAYS} days:`);
    lines.push("");
    for (const item of upcoming) {
      const dueText = item.daysAway === 0 ? "DUE TODAY" : item.daysAway === 1 ? "due tomorrow" : `due in ${item.daysAway} days`;
      lines.push(`  - Grievance ${item.id} (${item.employee})`);
      lines.push(`    ${item.deadlineLabel} ${dueText} — ${item.deadlineDate}`);
      lines.push("");
    }
  }

  lines.push("Art. V Sec. 3(b): Extensions to any deadline require mutual written agreement.");
  lines.push("Log in to the FCRC Grievance Tracker for full case details:");
  lines.push("https://dfcs-grievance-tracker.onrender.com");
  lines.push("");
  lines.push(`— ${localTag} | FCRC Grievance Tracker (automated reminder)`);
  return lines.join("\n");
}

// A day is only marked "done" once everyone due a reminder has actually been
// emailed. If some sends fail (Brevo outage, one bad address) the hourly check
// retries just the people who were missed. After this many automatic attempts
// it gives up for the day, so a permanently bad address can't make the check
// hit Brevo every hour all day.
const MAX_AUTOMATIC_ATTEMPTS_PER_DAY = 3;

/**
 * @param {{manual?: boolean}} [options] manual = an admin pressed "Run
 *   deadline check now": re-sends to everyone (as it always has) and doesn't
 *   use up one of the day's automatic retry attempts.
 */
async function runDeadlineCheck({ manual = false } = {}) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
  const summary = { sent: 0, skippedNoEmail: 0, skippedAlreadySent: 0, errors: [], stewardsNotified: [], retryScheduled: false };

  if (!apiKey || !senderEmail) {
    summary.errors.push("BREVO_API_KEY or BREVO_SENDER_EMAIL not set — no emails sent. See server/mailer.js for setup steps.");
    return summary;
  }

  const today = todayISO();
  const runState = await db.getEmailRunState(today);
  const alreadySent = new Set(manual ? [] : runState.sentTo);

  const localNo = await db.getOrgLocalNo().catch(() => "");
  const localTag = localNo ? `AFSCME Local ${localNo}` : "FCRC Grievance Tracker";

  const upcoming = await db.findUpcomingDeadlines(REMINDER_WINDOW_DAYS);

  const byEmail = new Map();
  for (const item of upcoming) {
    const email = (item.stewardEmail || "").trim();
    if (!email) { summary.skippedNoEmail++; continue; }
    if (!byEmail.has(email)) byEmail.set(email, { stewardName: item.steward || "Steward", items: [] });
    byEmail.get(email).items.push(item);
  }

  for (const [email, group] of byEmail.entries()) {
    if (alreadySent.has(email)) { summary.skippedAlreadySent++; continue; }
    const overdueCount = group.items.filter(i => i.daysAway < 0).length;
    const subject = overdueCount
      ? `\u26A0 [${localTag}] ${overdueCount} OVERDUE deadline${overdueCount > 1 ? "s" : ""}`
      : `[${localTag}] ${group.items.length} upcoming deadline${group.items.length > 1 ? "s" : ""}`;
    try {
      await sendMail({
        apiKey, senderEmail, to: email,
        subject,
        text: buildEmailBody(group.stewardName, group.items, localNo)
      });
      summary.sent++;
      if (!runState.sentTo.includes(email)) runState.sentTo.push(email);
      summary.stewardsNotified.push({ steward: group.stewardName, email, count: group.items.length });
      await db.logEmailAttempt({
        kind: "steward-deadline-digest", steward: group.stewardName, to: email,
        count: group.items.length, overdueCount, ok: true
      }).catch(logErr => console.error("[scheduler] Failed to write email log entry:", logErr.message));
    } catch (err) {
      // Some low-level network errors (blocked/refused outbound
      // connections, timeouts before a socket even connects) can
      // surface with an empty .message. Include .code and .name too
      // so a genuinely blank message doesn't leave us with nothing
      // to diagnose from.
      const detail = err && (err.message || err.code || err.name)
        ? [err.message, err.code, err.name].filter(Boolean).join(" | ")
        : String(err);
      summary.errors.push(`Failed to email ${email}: ${detail}`);
      console.error(`[scheduler] Failed to email ${email}:`, err);
      await db.logEmailAttempt({
        kind: "steward-deadline-digest", steward: group.stewardName, to: email,
        count: group.items.length, overdueCount, ok: false, error: detail
      }).catch(logErr => console.error("[scheduler] Failed to write email log entry:", logErr.message));
    }
  }

  // Individual send attempts are already logged per-steward above via
  // db.logEmailAttempt(). Here we decide whether today's run is finished.
  const everyoneNotified = [...byEmail.keys()].every(e => runState.sentTo.includes(e));
  if (!manual) runState.attempts += 1;
  const gaveUp = !manual && runState.attempts >= MAX_AUTOMATIC_ATTEMPTS_PER_DAY;
  await db.saveEmailRunState(runState);

  if (everyoneNotified || gaveUp) {
    // lastEmailRunDate is what stops the hourly check from re-running today.
    await db.withLock(async () => {
      await db.writeRawAtomic({ lastEmailRunDate: today });
      return null;
    });
    if (!everyoneNotified) {
      summary.errors.push(`Giving up for today after ${runState.attempts} attempts; some reminders were not delivered.`);
    }
  } else {
    // Someone was missed. Leave today un-marked so the next hourly check
    // retries only those people.
    summary.retryScheduled = true;
  }

  return summary;
}

function startScheduler() {
  setInterval(async () => {
    try {
      const data = await db.readRaw();
      const today = todayISO();
      if (data.lastEmailRunDate === today) return;
      console.log(`[scheduler] Running daily deadline check for ${today}...`);
      const summary = await runDeadlineCheck();
      console.log(`[scheduler] Done. Sent ${summary.sent} email(s), ${summary.errors.length} error(s).`);
    } catch (err) {
      console.error("[scheduler] Unexpected error during daily check:", err);
    }
  }, CHECK_INTERVAL_MS);
  console.log("[scheduler] Daily deadline email scheduler started.");
}

module.exports = { runDeadlineCheck, startScheduler };
