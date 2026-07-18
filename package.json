/**
 * ================================================================
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Email sending via the Brevo API (https://brevo.com, formerly
 * Sendinblue).
 *
 * Why Brevo and not Resend or raw Gmail SMTP?
 *   - Raw SMTP (Gmail direct) is blocked by Render's free tier —
 *     outbound connections to ports 25/465/587 reliably time out.
 *   - Resend (a good alternative) requires a VERIFIED DOMAIN before
 *     it will send to any recipient other than your own account
 *     email — a real cost/DNS-setup requirement.
 *   - Brevo sends over plain HTTPS (works on any hosting tier,
 *     including free) AND does not require a verified domain to
 *     send to arbitrary recipients. It only requires a verified
 *     SENDER EMAIL ADDRESS — a one-time step done by clicking a
 *     confirmation link Brevo emails you, no DNS/domain needed.
 *     Free tier: 300 emails/day, forever, no credit card.
 *
 * Setup on Render:
 *   1. Sign up at https://app.brevo.com (no credit card required)
 *   2. Go to Senders, Domains & Dedicated IPs → Senders → Add a
 *      Sender. Enter the email address you want to send FROM (can
 *      be your own Gmail/work email). Brevo emails that address a
 *      confirmation link — click it to verify.
 *   3. Go to SMTP & API → API Keys → Generate a new API key
 *   4. Set it as the BREVO_API_KEY environment variable on Render
 *   5. Set BREVO_SENDER_EMAIL to the exact address you verified in
 *      step 2 (must match exactly or sends will fail)
 *
 * Until a domain is verified with Brevo, the sender's domain part
 * may be automatically replaced with something like
 * yourname@xxxxx.brevosend.com for deliverability reasons — this
 * is cosmetic only; the emails still send and arrive normally.
 * ================================================================
 */

const https = require("https");

const BREVO_API_HOST = "api.brevo.com";
const DEFAULT_SENDER_NAME = "FCRC Grievance Tracker";

/**
 * Sends a plain-text email via the Brevo API.
 * Returns { ok: true, id } on success, throws a descriptive Error on failure.
 *
 * `apiKey` and `senderEmail` are required. `senderEmail` must exactly
 * match a sender address that has been verified in the Brevo dashboard.
 */
function sendMail({ apiKey, senderEmail, senderName, to, subject, text }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error("BREVO_API_KEY is not set — cannot send email."));
      return;
    }
    if (!senderEmail) {
      reject(new Error("BREVO_SENDER_EMAIL is not set — cannot send email. This must be a sender address you've verified in your Brevo dashboard."));
      return;
    }

    const payload = JSON.stringify({
      sender: { name: senderName || DEFAULT_SENDER_NAME, email: senderEmail },
      to: [{ email: to }],
      subject,
      textContent: text
    });

    const req = https.request(
      {
        hostname: BREVO_API_HOST,
        path: "/v3/smtp/email",
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 15000
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { /* leave as null */ }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, id: parsed && parsed.messageId });
          } else {
            const detail = (parsed && (parsed.message || parsed.code)) || body || `HTTP ${res.statusCode}`;
            reject(new Error(`Brevo API error (${res.statusCode}): ${detail}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      const detail = err && (err.message || err.code || err.name) || String(err);
      reject(new Error(`Could not reach Brevo API: ${detail}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Brevo API request timed out after 15s."));
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { sendMail };
