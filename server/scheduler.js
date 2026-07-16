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

function todayISO() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
}

function buildEmailBody(stewardName, items) {
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
  lines.push("Log in to the FCRC Grievance Tracker for full case details.");
  lines.push("");
  lines.push("— AFSCME Council 31 FCRC Grievance Tracker (automated reminder)");
  return lines.join("\n");
}

async function runDeadlineCheck() {
  const gmailUser = process.env.GMAIL_USER || "";
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || "";
  const summary = { sent: 0, skippedNoEmail: 0, errors: [], stewardsNotified: [] };

  if (!gmailUser || !gmailAppPassword) {
    summary.errors.push("GMAIL_USER or GMAIL_APP_PASSWORD not set — no emails sent.");
    return summary;
  }

  const upcoming = await db.findUpcomingDeadlines(REMINDER_WINDOW_DAYS);

  const byEmail = new Map();
  for (const item of upcoming) {
    const email = (item.stewardEmail || "").trim();
    if (!email) { summary.skippedNoEmail++; continue; }
    if (!byEmail.has(email)) byEmail.set(email, { stewardName: item.steward || "Steward", items: [] });
    byEmail.get(email).items.push(item);
  }

  for (const [email, group] of byEmail.entries()) {
    const overdueCount = group.items.filter(i => i.daysAway < 0).length;
    const subject = overdueCount
      ? `\u26A0 FCRC Grievance Tracker — ${overdueCount} OVERDUE deadline${overdueCount > 1 ? "s" : ""}`
      : `FCRC Grievance Tracker — ${group.items.length} upcoming deadline${group.items.length > 1 ? "s" : ""}`;
    try {
      await sendMail({
        user: gmailUser, appPassword: gmailAppPassword, to: email,
        subject,
        text: buildEmailBody(group.stewardName, group.items)
      });
      summary.sent++;
      summary.stewardsNotified.push({ steward: group.stewardName, email, count: group.items.length });
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
    }
  }

  await db.withLock(async () => {
    const fresh = {
      lastEmailRunDate: todayISO(),
      emailLog: [{
        date: new Date().toISOString(),
        sent: summary.sent,
        skippedNoEmail: summary.skippedNoEmail,
        errors: summary.errors,
        stewardsNotified: summary.stewardsNotified
      }]
    };
    await db.writeRawAtomic(fresh);
    return null;
  });

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
