/**
 * Emails for updating a member's own contact entry:
 *  - the one-time update link, sent to the personal email on file
 *  - a confirmation, sent to a new personal email after it has been changed
 * Uses the same Brevo sender as the other app emails.
 */

const { sendMail } = require("./mailer");
const db = require("./db");

const DEFAULT_REPLY_TO = "local2858fcrc@gmail.com";

function mailConfig() {
  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
  if (!apiKey || !senderEmail) {
    throw new Error("Email is not configured (BREVO_API_KEY and BREVO_SENDER_EMAIL). The link was not sent.");
  }
  return { apiKey, senderEmail, replyTo: process.env.NEWSLETTER_REPLY_TO || DEFAULT_REPLY_TO };
}

// The sender name is the union, not the app, so members see who is writing.
function unionSenderName(localNo) {
  return localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
}

async function sendUpdateLink({ submissionId, createdBy, baseUrl }) {
  const cfg = mailConfig();
  const link = await db.createContactUpdateLink(submissionId, createdBy);
  const url = `${baseUrl}/update/${link.token}`;
  const localNo = await db.getOrgLocalNo().catch(() => "");
  const tag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
  const text = [
    `Hello ${link.legalName},`,
    "",
    `Use this private link to update your contact details with ${tag}:`,
    url,
    "",
    "The link works once and expires in 72 hours. If you did not ask for this, you can ignore this email.",
    "",
    "— FCRC Grievance Tracker (automated message)"
  ].join("\n");
  try {
    await sendMail({ ...cfg, senderName: unionSenderName(localNo), to: link.sentTo, subject: `[${tag}] Update your contact details`, text });
  } catch (err) {
    await db.expireContactUpdateLink(link.token).catch(() => {});
    throw err;
  }
  await db.logEmailAttempt({ kind: "contact-update-link", to: link.sentTo, ok: true }).catch(() => {});
  return { sentTo: link.sentTo };
}

async function sendChangeConfirmation({ to, legalName }) {
  const cfg = mailConfig();
  const localNo = await db.getOrgLocalNo().catch(() => "");
  const tag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
  const text = [
    `Hello ${legalName},`,
    "",
    `Your contact details with ${tag} were updated, and this address is now the personal email on file.`,
    "If you did not make this change, please tell your steward straight away.",
    "",
    "— FCRC Grievance Tracker (automated message)"
  ].join("\n");
  await sendMail({ ...cfg, senderName: unionSenderName(localNo), to, subject: `[${tag}] Your contact details were updated`, text });
  await db.logEmailAttempt({ kind: "contact-update-confirmation", to, ok: true }).catch(() => {});
}

module.exports = { sendUpdateLink, sendChangeConfirmation };
