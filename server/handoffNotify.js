/**
 * ================================================================
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Hand-off notifications.
 *
 * Emails the receiving steward when a grievance is handed off to
 * them. The address is the email on their user record (Settings →
 * Manage users).
 *
 * Best-effort: if email isn't configured or no address is on file,
 * nothing is sent and the hand-off itself is unaffected. Every
 * attempt (sent, failed, or skipped for a missing address) is
 * written to the email log so an admin can see what happened.
 *
 * Uses the same Brevo sender as the other emails (server/mailer.js).
 * ================================================================
 */

const { sendMail } = require("./mailer");
const db = require("./db");

const APP_URL = "https://dfcs-grievance-tracker.onrender.com";

function buildHandoffEmailBody({ toName, fromName, gid, employee, localNo }) {
  const localTag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
  const lines = [];
  lines.push(`Dear ${toName},`);
  lines.push("");
  lines.push(`${fromName} has handed off Grievance ${gid}${employee ? ` (${employee})` : ""} to you.`);
  lines.push("");
  lines.push("You now hold the lock on this grievance, which means you are the one who can edit it.");
  lines.push("Please log in and review the case, including its upcoming deadlines:");
  lines.push(APP_URL);
  lines.push("");
  lines.push(`— ${localTag} | FCRC Grievance Tracker (automated notice)`);
  return lines.join("\n");
}

/**
 * Looks up the email on file for a login account by matching its display
 * name (or, failing that, its username) against the steward list.
 * Returns "" when there is no match or no address.
 */
async function findStewardEmail(user) {
  const email = String((user && user.email) || "").trim();
  return email.includes("@") ? email : "";
}

/**
 * @param {object} args
 * @param {string} args.gid        grievance ID
 * @param {string} args.employee   grievant name (may be blank)
 * @param {object} args.toUser     { username, displayName }
 * @param {object} args.fromUser   { username, displayName }
 */
async function sendHandoffNotification({ gid, employee, toUser, fromUser }) {
  const toName = toUser.displayName || toUser.username;
  const fromName = fromUser.displayName || fromUser.username;
  const logBase = { kind: "handoff-notice", gid, steward: toName, from: fromName };

  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
  if (!apiKey || !senderEmail) return { sent: false, reason: "email-not-configured" };

  const to = await findStewardEmail(toUser);
  if (!to) {
    await db.logEmailAttempt({
      ...logBase, to: "", ok: false,
      error: `No email on file for ${toName}. Add an email address for them in Settings → Manage users.`
    }).catch(err => console.error("[handoff] Failed to write email log entry:", err.message));
    return { sent: false, reason: "no-email" };
  }

  const localNo = await db.getOrgLocalNo().catch(() => "");
  const localTag = localNo ? `AFSCME Local ${localNo}` : "FCRC Grievance Tracker";
  try {
    await sendMail({
      apiKey, senderEmail, to,
      subject: `[${localTag}] Grievance ${gid} handed off to you`,
      text: buildHandoffEmailBody({ toName, fromName, gid, employee, localNo })
    });
    await db.logEmailAttempt({ ...logBase, to, ok: true })
      .catch(err => console.error("[handoff] Failed to write email log entry:", err.message));
    return { sent: true };
  } catch (err) {
    const detail = err && (err.message || err.code || err.name)
      ? [err.message, err.code, err.name].filter(Boolean).join(" | ")
      : String(err);
    await db.logEmailAttempt({ ...logBase, to, ok: false, error: detail })
      .catch(logErr => console.error("[handoff] Failed to write email log entry:", logErr.message));
    return { sent: false, reason: "send-failed" };
  }
}

module.exports = { sendHandoffNotification, findStewardEmail, buildHandoffEmailBody };
