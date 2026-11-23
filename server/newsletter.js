/**
 * Sends to members in two ways:
 *  - "newsletter": to people who opted in, on personal email, with an unsubscribe link.
 *  - "notice": union business to people who gave a state email as union contact.
 *    There is no unsubscribe for notices. Each send needs a reason and a confirmation
 *    that the content is union business.
 * One email per person, a short pause between sends, and a log entry for each send.
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

function paragraphsHtml(body) {
  return String(body || "").split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;line-height:1.55;">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Newsletter email: header, text, developer credit, and that person's unsubscribe link. */
function buildEmail({ subject, body, localNo, unsubscribeUrl, recipientName }) {
  const tag = localTag(localNo);
  const greeting = recipientName ? `Hello ${recipientName},` : "Hello,";
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f5f3ef;font-family:-apple-system,Segoe UI,sans-serif;color:#1a2b22;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:#005daa;color:#fff;padding:20px 24px;">
      <div style="font-size:19px;font-weight:700;">${esc(tag)}</div>
      <div style="font-size:13px;opacity:.9;margin-top:4px;">Member newsletter</div>
    </div>
    <div style="padding:24px;font-size:15px;">
      <p style="margin:0 0 14px;">${esc(greeting)}</p>
      ${paragraphsHtml(body)}
    </div>
    <div style="padding:16px 24px;background:#f1f5f8;font-size:12px;color:#5f6f64;line-height:1.5;">
      You are receiving this because you opted in to union newsletters.
      <a href="${esc(unsubscribeUrl)}" style="color:#005daa;">Unsubscribe</a>.<br>
      Developed by Hazem Albassam &middot; &copy; 2026
    </div>
  </div></body></html>`;
  const text = [greeting, "", String(body || ""), "", "----",
    "You are receiving this because you opted in to union newsletters.",
    `To unsubscribe: ${unsubscribeUrl}`, "Developed by Hazem Albassam"].join("\n");
  return { subject: `[${tag}] ${subject}`, html, text };
}

/** Union business notice: no unsubscribe. The footer explains why the person received it. */
function buildNotice({ subject, body, localNo, recipientName, replyTo }) {
  const tag = localTag(localNo);
  const greeting = recipientName ? `Hello ${recipientName},` : "Hello,";
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f5f3ef;font-family:-apple-system,Segoe UI,sans-serif;color:#1a2b22;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:#005daa;color:#fff;padding:20px 24px;">
      <div style="font-size:19px;font-weight:700;">${esc(tag)}</div>
      <div style="font-size:13px;opacity:.9;margin-top:4px;">Union business notice</div>
    </div>
    <div style="padding:24px;font-size:15px;">
      <p style="margin:0 0 14px;">${esc(greeting)}</p>
      ${paragraphsHtml(body)}
    </div>
    <div style="padding:16px 24px;background:#f1f5f8;font-size:12px;color:#5f6f64;line-height:1.5;">
      You are receiving this union business notice because you gave this state email address as your union contact.
      To correct your details, contact your steward${replyTo ? ` or write to ${esc(replyTo)}` : ""}.<br>
      Developed by Hazem Albassam &middot; &copy; 2026
    </div>
  </div></body></html>`;
  const text = [greeting, "", String(body || ""), "", "----",
    "You are receiving this union business notice because you gave this state email address as your union contact.",
    `To correct your details, contact your steward${replyTo ? ` or write to ${replyTo}` : ""}.`,
    "Developed by Hazem Albassam"].join("\n");
  return { subject: `[${tag}] Union notice: ${subject}`, html, text };
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

/** A union business notice needs a reason and a confirmation that it is union business. */
function validateNotice({ subject, body, reason, businessConfirm }) {
  const v = validateNewsletter({ subject, body, addressType: "state", reason });
  if (!String(reason || "").trim()) throw new Error("Give the reason for this notice.");
  if (businessConfirm !== true) throw new Error("Confirm that this notice is union business only.");
  return v;
}

/** Recipients for a send, with one email per address. */
async function recipientsFor({ kind, location, addressType }) {
  const people = kind === "notice"
    ? await db.getNoticeRecipients({ location })
    : await db.getNewsletterRecipients({ location, addressType });
  const seen = new Set();
  return people.filter(p => {
    const key = p.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sends one copy of a finished newsletter or notice to each copy address: the copy address
 *  set in the Members tab, and the record-keeping address set in Settings. A blank address is
 *  skipped, and an address that appears twice gets one copy. The copy has the text and the
 *  results. It does not list names or addresses; those stay in the app. */
async function sendCopy({ cfg, localNo, id, isNotice, v, audience, loc, type, reason, sentBy, sent, failed, total }) {
  let targets;
  try {
    const membersCopy = await db.getNewsletterCopyEmail();
    const recordCopy = await db.getRecordKeepingEmail();
    targets = [...new Set([membersCopy, recordCopy].filter(Boolean))];
  } catch (err) {
    console.error("[newsletter] copy addresses failed:", err.message);
    await db.logEmailAttempt({ kind: "newsletter-copy", gid: id, to: "", ok: false, error: err.message }).catch(() => {});
    return;
  }
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const who = audience === "all" ? "the whole local" : loc;
  const addr = isNotice || type === "state" ? "state" : "personal";
  const text = [
    `A copy of a ${isNotice ? "union business notice" : "newsletter"} sent to members.`,
    "",
    `Subject: ${v.subject}`,
    `Sent by: ${sentBy || "(unknown)"}`,
    `Sent at: ${when}`,
    `Sent to: ${who}, ${addr} email addresses`,
    ...(isNotice ? [`Reason: ${String(reason || "").trim()}`] : []),
    `Results: ${sent} sent, ${failed} failed, of ${total}`,
    "",
    "Text as written:",
    "",
    v.body,
    "",
    `Each member's copy also had the union header${isNotice ? "" : " and a personal unsubscribe link"} added automatically.`,
    "",
    "This copy is sent automatically. Names and addresses of recipients are in the Members tab under Past communications."
  ].join("\n");
  for (const to of targets) {
    try {
      await sendMail({ ...cfg, senderName: localTag(localNo), to, subject: `[Copy] ${v.subject}`, text, replyTo: cfg.replyTo });
      await db.logEmailAttempt({ kind: "newsletter-copy", gid: id, to, ok: true }).catch(() => {});
    } catch (err) {
      console.error("[newsletter] copy failed:", err.message);
      await db.logEmailAttempt({ kind: "newsletter-copy", gid: id, to, ok: false, error: err.message }).catch(() => {});
    }
  }
}

/** Sends to everyone for the chosen audience. Returns at once with the record id and the
 *  number of recipients. Sending continues in the background. */
async function startNewsletter({ kind, subject, body, audience, location, addressType, reason, businessConfirm, sentBy, baseUrl, localNo }) {
  const isNotice = kind === "notice";
  const v = isNotice ? validateNotice({ subject, body, reason, businessConfirm }) : validateNewsletter({ subject, body, addressType, reason });
  const cfg = mailConfig();
  if (audience !== "all" && audience !== "location") throw new Error("Choose a location or the whole local.");
  const loc = audience === "location" ? String(location || "").trim() : "";
  if (audience === "location" && !(await db.getLocationList()).includes(loc)) {
    throw new Error("That location is not in the location list.");
  }
  const type = isNotice ? "state" : addressType;
  const recipients = await recipientsFor({ kind: isNotice ? "notice" : "newsletter", location: loc, addressType: type });

  const id = await db.createNewsletterRecord({
    subject: v.subject, body: v.body, audience, location: loc, addressType: type,
    reason: type === "state" ? String(reason).trim() : "", sentBy, recipients: recipients.length,
    kind: isNotice ? "notice" : "newsletter"
  });

  (async () => {
    let sent = 0, failed = 0;
    for (const person of recipients) {
      let msg;
      if (isNotice) {
        msg = buildNotice({ subject: v.subject, body: v.body, localNo, recipientName: person.legalName, replyTo: cfg.replyTo });
      } else {
        const unsubscribeUrl = `${baseUrl}/unsubscribe/${person.unsubscribeToken}`;
        msg = buildEmail({ subject: v.subject, body: v.body, localNo, unsubscribeUrl, recipientName: person.legalName });
      }
      try {
        await sendMail({ ...cfg, senderName: person.location ? `${localTag(localNo)} · ${person.location}` : localTag(localNo),
          to: person.email, subject: msg.subject, text: msg.text, html: msg.html, replyTo: cfg.replyTo });
        sent++;
        await db.logEmailAttempt({ kind: isNotice ? "union-notice" : "newsletter", gid: id, to: person.email, ok: true }).catch(() => {});
        await db.logMemberMail({ kind: isNotice ? "union-notice" : "newsletter", newsletterId: id, legalName: person.legalName, email: person.email, ok: true }).catch(() => {});
      } catch (err) {
        failed++;
        await db.logEmailAttempt({ kind: isNotice ? "union-notice" : "newsletter", gid: id, to: person.email, ok: false, error: err.message }).catch(() => {});
        await db.logMemberMail({ kind: isNotice ? "union-notice" : "newsletter", newsletterId: id, legalName: person.legalName, email: person.email, ok: false, error: err.message }).catch(() => {});
      }
      await db.updateNewsletterProgress(id, sent, failed).catch(() => {});
      await new Promise(r => setTimeout(r, SEND_PAUSE_MS));
    }
    await db.finishNewsletterRecord(id, sent, failed).catch(err => console.error("[newsletter] finish failed:", err.message));
    await sendCopy({ cfg, localNo, id, isNotice, v, audience, loc, type, reason, sentBy, sent, failed, total: recipients.length });
  })().catch(err => console.error("[newsletter] send failed:", err.message));

  db.purgeOldNewsletters().catch(() => {});
  return { id, recipients: recipients.length };
}

/** One test email to the test address. No recipient list is used. */
async function sendTest({ kind, subject, body, addressType, reason, businessConfirm, baseUrl, localNo }) {
  const isNotice = kind === "notice";
  const v = isNotice ? validateNotice({ subject, body, reason, businessConfirm }) : validateNewsletter({ subject, body, addressType, reason });
  const cfg = mailConfig();
  const to = process.env.NEWSLETTER_TEST_EMAIL || DEFAULT_REPLY_TO;
  const msg = isNotice
    ? buildNotice({ subject: v.subject, body: v.body, localNo, recipientName: "", replyTo: cfg.replyTo })
    : buildEmail({ subject: v.subject, body: v.body, localNo, unsubscribeUrl: `${baseUrl}/unsubscribe/test`, recipientName: "" });
  await sendMail({ ...cfg, senderName: localTag(localNo), to, subject: `TEST ${msg.subject}`, text: msg.text, html: msg.html, replyTo: cfg.replyTo });
  return { sentTo: to };
}

module.exports = { startNewsletter, sendTest, recipientsFor, buildEmail, buildNotice, validateNewsletter, validateNotice };
