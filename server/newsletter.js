/**
 * Newsletters to members who opted in. One email per person, a short pause between
 * sends, and a log entry for every send. Each email carries that person's own
 * unsubscribe link.
 */

const { sendMail } = require("./mailer");
const db = require("./db");

const DEFAULT_REPLY_TO = "local2858fcrc@gmail.com";
const SEND_PAUSE_MS = 250;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function mailConfig() {
  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";
  if (!apiKey || !senderEmail) throw new Error("Email is not configured (BREVO_API_KEY and BREVO_SENDER_EMAIL).");
  return { apiKey, senderEmail, replyTo: process.env.NEWSLETTER_REPLY_TO || DEFAULT_REPLY_TO };
}

function localTag(localNo) {
  return localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
}

/** The header is the union name and local number. The footer carries the developer
 *  credit and the unsubscribe link. The body is escaped, so it cannot inject markup. */
function buildEmail({ subject, body, localNo, unsubscribeUrl, recipientName }) {
  const tag = localTag(localNo);
  const greeting = recipientName ? `Hello ${recipientName},` : "Hello,";
  const paragraphs = String(body || "").split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;line-height:1.55;">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f5f3ef;font-family:-apple-system,Segoe UI,sans-serif;color:#1a2b22;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:#005daa;color:#fff;padding:20px 24px;">
      <div style="font-size:19px;font-weight:700;">${esc(tag)}</div>
      <div style="font-size:13px;opacity:.9;margin-top:4px;">Member newsletter</div>
    </div>
    <div style="padding:24px;font-size:15px;">
      <p style="margin:0 0 14px;">${esc(greeting)}</p>
      ${paragraphs}
    </div>
    <div style="padding:16px 24px;background:#f1f5f8;font-size:12px;color:#5f6f64;line-height:1.5;">
      You are receiving this because you opted in to union newsletters.
      <a href="${esc(unsubscribeUrl)}" style="color:#005daa;">Unsubscribe</a>.<br>
      Developed by Hazem Albassam &middot; &copy; 2026
    </div>
  </div></body></html>`;
  const text = [
    greeting,
    "",
    String(body || ""),
    "",
    "----",
    `You are receiving this because you opted in to union newsletters.`,
    `To unsubscribe: ${unsubscribeUrl}`,
    "Developed by Hazem Albassam"
  ].join("\n");
  return { subject: `[${tag}] ${subject}`, html, text };
}

function validateNewsletter({ subject, body, addressType, reason }) {
  const s = String(subject || "").trim();
  const b = String(body || "").trim();
  if (!s) throw new Error("Enter a subject.");
  if (s.length > 150) throw new Error("The subject is too long.");
  if (!b) throw new Error("Write the newsletter text.");
  if (b.length > 20000) throw new Error("The newsletter is too long.");
  if (!["personal", "state"].includes(addressType)) throw new Error("Choose personal or state emails.");
  if (addressType === "state" && !String(reason || "").trim()) {
    throw new Error("State emails are used only in special circumstances. Give the reason.");
  }
  return { subject: s, body: b };
}

/** Sends a newsletter to everyone who opted in for the chosen audience. Returns at once
 *  with the record id and the number of recipients. Sending continues in the background. */
async function startNewsletter({ subject, body, audience, location, addressType, reason, sentBy, baseUrl, localNo }) {
  const v = validateNewsletter({ subject, body, addressType, reason });
  const cfg = mailConfig();
  if (audience !== "all" && audience !== "location") throw new Error("Choose a location or the whole local.");
  const loc = audience === "location" ? String(location || "").trim() : "";
  if (audience === "location" && !(await db.getLocationList()).includes(loc)) {
    throw new Error("That location is not in the location list.");
  }

  // One email per address, even if two entries share it.
  const people = await db.getNewsletterRecipients({ location: loc, addressType });
  const seen = new Set();
  const recipients = people.filter(p => {
    const key = p.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const id = await db.createNewsletterRecord({
    subject: v.subject, body: v.body, audience, location: loc, addressType,
    reason: addressType === "state" ? String(reason).trim() : "", sentBy, recipients: recipients.length
  });

  // Background send: one email at a time, with a pause between them.
  (async () => {
    let sent = 0, failed = 0;
    for (const person of recipients) {
      const unsubscribeUrl = `${baseUrl}/unsubscribe/${person.unsubscribeToken}`;
      const msg = buildEmail({ subject: v.subject, body: v.body, localNo, unsubscribeUrl, recipientName: person.legalName });
      try {
        await sendMail({ ...cfg, senderName: person.location ? `${localTag(localNo)} · ${person.location}` : localTag(localNo),
          to: person.email, subject: msg.subject, text: msg.text, html: msg.html, replyTo: cfg.replyTo });
        sent++;
        await db.logEmailAttempt({ kind: "newsletter", gid: id, to: person.email, ok: true }).catch(() => {});
      } catch (err) {
        failed++;
        await db.logEmailAttempt({ kind: "newsletter", gid: id, to: person.email, ok: false, error: err.message }).catch(() => {});
      }
      await db.updateNewsletterProgress(id, sent, failed).catch(() => {});
      await new Promise(r => setTimeout(r, SEND_PAUSE_MS));
    }
    await db.finishNewsletterRecord(id, sent, failed).catch(err => console.error("[newsletter] finish failed:", err.message));
  })().catch(err => console.error("[newsletter] send failed:", err.message));

  db.purgeOldNewsletters().catch(() => {});
  return { id, recipients: recipients.length };
}

/** One test email to the test address. No recipient list is used. */
async function sendTest({ subject, body, addressType, reason, baseUrl, localNo }) {
  const v = validateNewsletter({ subject, body, addressType, reason });
  const cfg = mailConfig();
  const to = process.env.NEWSLETTER_TEST_EMAIL || DEFAULT_REPLY_TO;
  const msg = buildEmail({ subject: v.subject, body: v.body, localNo, unsubscribeUrl: `${baseUrl}/unsubscribe/test`, recipientName: "" });
  await sendMail({ ...cfg, senderName: localTag(localNo), to, subject: `TEST ${msg.subject}`, text: msg.text, html: msg.html, replyTo: cfg.replyTo });
  return { sentTo: to };
}

module.exports = { startNewsletter, sendTest, buildEmail, validateNewsletter };
