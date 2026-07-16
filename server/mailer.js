/**
 * ================================================================
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Email sending via the Resend API (https://resend.com).
 *
 * Why not raw SMTP? Render's free tier (and many other free hosts)
 * block outbound traffic on SMTP ports (25, 465, 587) to prevent
 * spam abuse. That makes it impossible to connect directly to
 * Gmail's SMTP server from a Render-hosted app — connections
 * reliably time out (ETIMEDOUT). Resend sends over plain HTTPS
 * (port 443), which is never blocked, so this works on any hosting
 * tier including free.
 *
 * Setup on Render:
 *   1. Sign up at https://resend.com (no credit card required)
 *   2. Create an API key: https://resend.com/api-keys
 *   3. Set it as the RESEND_API_KEY environment variable on Render
 *
 * No domain verification is required to get started — by default
 * this sends from Resend's shared address (onboarding@resend.dev).
 * Once you verify your own domain with Resend, set RESEND_FROM_EMAIL
 * to your own address (e.g. noreply@yourlocal.org) and this will
 * automatically switch to sending from it — no code changes needed.
 * ================================================================
 */

const https = require("https");

const RESEND_API_HOST = "api.resend.com";
const DEFAULT_FROM = "FCRC Grievance Tracker <onboarding@resend.dev>";

/**
 * Sends a plain-text email via the Resend API.
 * Returns { ok: true, id } on success, throws a descriptive Error on failure.
 *
 * `apiKey` is required. `from` is optional — defaults to Resend's
 * shared sending address, or RESEND_FROM_EMAIL if set by the caller.
 */
function sendMail({ apiKey, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error("RESEND_API_KEY is not set — cannot send email."));
      return;
    }

    const payload = JSON.stringify({
      from: from || DEFAULT_FROM,
      to: [to],
      subject,
      text
    });

    const req = https.request(
      {
        hostname: RESEND_API_HOST,
        path: "/emails",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
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
            resolve({ ok: true, id: parsed && parsed.id });
          } else {
            const detail = (parsed && (parsed.message || parsed.name)) || body || `HTTP ${res.statusCode}`;
            reject(new Error(`Resend API error (${res.statusCode}): ${detail}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      const detail = err && (err.message || err.code || err.name) || String(err);
      reject(new Error(`Could not reach Resend API: ${detail}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Resend API request timed out after 15s."));
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { sendMail };
