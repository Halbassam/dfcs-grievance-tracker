/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Daily deadline email scheduler.
 *
 * Render's free tier puts services to sleep after 15 minutes of
 * no traffic, so a traditional cron job that fires "every day at
 * 8am" can't be relied on — the process might be asleep at 8am.
 *
 * Instead, this checks once a minute (cheap, no real cost) whether
 * today's date is different from the last day an email run
 * happened. The first time the app is awake on a new day, it runs
 * the check. This means the exact time of day it runs can drift
 * depending on when stewards happen to open the site, but it
 * guarantees it runs once per day that the app is used at all.
 *
 * If you want a guaranteed fixed time every single day regardless
 * of traffic, that requires Render's paid tier (no sleep) or an
 * external uptime-ping service to keep it awake — not necessary
 * for most locals, but mentioned here for completeness.
 * ================================================================
 */

const db = require("./db");
const { sendMail } = require("./mailer");

const CHECK_INTERVAL_MS = 60 * 1000; // check once a minute
const REMINDER_WINDOW_DAYS = 3; // email about anything due within 3 days

function todayISO() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function buildEmailBody(stewardName, items) {
  const lines = [];
  lines.push(`Hello ${stewardName},`);
  lines.push("");
  lines.push("The following grievance deadline(s) are coming up within the next " + REMINDER_WINDOW_DAYS + " days:");
  lines.push("");
  for (const item of items) {
    const dueText = item.daysAway === 0 ? "DUE TODAY" : item.daysAway === 1 ? "due tomorrow" : `due in ${item.daysAway} days`;
    lines.push(`  - Grievance ${item.id} (${item.employee})`);
    lines.push(`    ${item.deadlineLabel} ${dueText} — ${item.deadlineDate}`);
    lines.push("");
  }
  lines.push("Art. V Sec. 3(b): Extensions to any deadline require mutual written agreement.");
  lines.push("Log in to the DFCS Grievance Tracker for full case details.");
  lines.push("");
  lines.push("— AFSCME Council 31 DFCS Grievance Tracker (automated reminder)");
  return lines.join("\n");
}

/**
 * Runs the deadline check and emails every steward who has at
 * least one upcoming deadline. Returns a summary of what happened
 * (used by both the daily auto-run and the manual "run now" button).
 */
async function runDeadlineCheck() {
  const data = db.readRaw();
  const gmailUser = process.env.GMAIL_USER || "";
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || "";

  const summary = { sent: 0, skippedNoEmail: 0, errors: [], stewardsNotified: [] };

  if (!gmailUser || !gmailAppPassword) {
    summary.errors.push("GMAIL_USER or GMAIL_APP_PASSWORD environment variable is not set — no emails were sent.");
    return summary;
  }

  const upcoming = db.findUpcomingDeadlines(REMINDER_WINDOW_DAYS);

  // Group by steward email so each steward gets ONE email listing all their cases
  const byEmail = new Map();
  for (const item of upcoming) {
    const email = (item.stewardEmail || "").trim();
    if (!email) {
      summary.skippedNoEmail++;
      continue;
    }
    if (!byEmail.has(email)) {
      byEmail.set(email, { stewardName: item.steward || "Steward", items: [] });
    }
    byEmail.get(email).items.push(item);
  }

  for (const [email, group] of byEmail.entries()) {
    try {
      await sendMail({
        user: gmailUser,
        appPassword: gmailAppPassword,
        to: email,
        subject: `DFCS Grievance Tracker — ${group.items.length} upcoming deadline${group.items.length > 1 ? "s" : ""}`,
        text: buildEmailBody(group.stewardName, group.items)
      });
      summary.sent++;
      summary.stewardsNotified.push({ steward: group.stewardName, email, count: group.items.length });
    } catch (err) {
      summary.errors.push(`Failed to email ${email}: ${err.message}`);
    }
  }

  // Record this run in the data file so it shows up in an email log /
  // can be inspected later, and so the daily scheduler knows it already
  // ran today.
  await db.withLock(() => {
    const fresh = db.readRaw();
    fresh.lastEmailRunDate = todayISO();
    fresh.emailLog = fresh.emailLog || [];
    fresh.emailLog.unshift({
      date: new Date().toISOString(),
      sent: summary.sent,
      skippedNoEmail: summary.skippedNoEmail,
      errors: summary.errors,
      stewardsNotified: summary.stewardsNotified
    });
    // Keep only the most recent 60 log entries so the file doesn't grow forever
    fresh.emailLog = fresh.emailLog.slice(0, 60);
    db.writeRawAtomic(fresh);
    return null;
  });

  return summary;
}

/**
 * Starts the once-a-minute check. Call this once when the server
 * boots. It is safe to call multiple times only once per process.
 */
function startScheduler() {
  setInterval(async () => {
    try {
      const data = db.readRaw();
      const today = todayISO();
      if (data.lastEmailRunDate === today) return; // already ran today

      console.log(`[scheduler] Running daily deadline check for ${today}...`);
      const summary = await runDeadlineCheck();
      console.log(`[scheduler] Done. Sent ${summary.sent} email(s), ${summary.errors.length} error(s).`);
    } catch (err) {
      console.error("[scheduler] Unexpected error during daily check:", err);
    }
  }, CHECK_INTERVAL_MS);

  console.log("[scheduler] Daily deadline email scheduler started.");
}

module.exports = { startScheduler, runDeadlineCheck };
