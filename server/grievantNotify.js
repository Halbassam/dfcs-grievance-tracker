/**
 * ================================================================
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Grievant progress notifications.
 *
 * Sends an email to the grievant(s) named on a case whenever Step 1,
 * Step 2, or Step 3 is newly filed (transitions from blank to a
 * date in the same save). Entirely optional per-case — if no
 * grievantEmail is on file, nothing is sent and nothing errors.
 *
 * For "All Affected" / group grievances, grievantEmail may contain
 * multiple addresses separated by commas — each gets its own email.
 *
 * Uses the same Brevo API sender as the steward deadline reminders
 * (server/mailer.js) — no separate configuration needed.
 * ================================================================
 */

const { sendMail } = require("./mailer");
const db = require("./db");

function parseEmailList(raw) {
  return String(raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.includes("@"));
}

const STEP_LABELS = {
  step1: "Step 1 (Oral Grievance)",
  step2: "Step 2 (Written Grievance)",
  step3: "Step 3 (Agency Head)"
};

function buildStepEmailBody(rec, step, localNo) {
  const localTag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";
  const lines = [];
  lines.push(`Dear ${rec.employee || "Grievant"},`);
  lines.push("");
  lines.push(`This is an update on your grievance (Case ${rec.id}) filed with ${localTag}.`);
  lines.push("");

  if (step === "step1") {
    lines.push(`Your grievance has been filed at ${STEP_LABELS.step1}.`);
    lines.push("");
    lines.push("What happens next: your steward has raised this grievance orally with your immediate supervisor.");
    lines.push("Expected response timeframe: the supervisor's response is due within 10 working days of filing.");
    lines.push("If a satisfactory response isn't received in that time, the grievance will normally advance to Step 2.");
  } else if (step === "step2") {
    lines.push(`Your grievance has advanced to ${STEP_LABELS.step2}.`);
    lines.push("");
    lines.push("What happens next: a written grievance has been filed with the Intermediate Administrator or their designee. A meeting may be held to discuss the grievance.");
    lines.push("Expected response timeframe: a written answer is due within 15 working days of receipt.");
    lines.push("If a satisfactory response isn't received in that time, the grievance will normally advance to Step 3.");
  } else if (step === "step3") {
    lines.push(`Your grievance has advanced to ${STEP_LABELS.step3}.`);
    lines.push("");
    lines.push("What happens next: the grievance has been filed with the Agency Head and a copy sent to Council 31. From this point, AFSCME Council 31 staff take over primary handling of your case, including any further scheduling with the Agency.");
    // Per local policy, no expected response timeframe is stated for
    // Step 3 — timing depends on the monthly grievance committee
    // schedule and other factors that make a firm estimate unreliable.
  }

  lines.push("");
  lines.push("Your steward will keep you informed as your case progresses. If you have questions in the meantime, please reach out to your steward directly.");
  lines.push("");
  lines.push(`— ${localTag} | FCRC Grievance Tracker (automated notification)`);
  return lines.join("\n");
}

/**
 * Sends progress-notification emails for whichever steps were newly
 * filed in this save. `newlyFiledSteps` is the object returned by
 * db.submitGrievance(), e.g. { step1: true, step2: false, step3: false }.
 *
 * Never throws — a failed or skipped notification should never block
 * the actual grievance save, which has already succeeded by the time
 * this runs. Returns a summary object for logging/testing purposes.
 */
async function sendGrievantStepNotifications(rec, newlyFiledSteps) {
  const summary = { attempted: [], sent: [], skippedNoEmail: false, errors: [] };

  const apiKey = process.env.BREVO_API_KEY || "";
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "";

  const recipients = parseEmailList(rec.grievantEmail);
  if (recipients.length === 0) {
    summary.skippedNoEmail = true;
    return summary;
  }

  if (!apiKey || !senderEmail) {
    summary.errors.push("BREVO_API_KEY or BREVO_SENDER_EMAIL not set — grievant notification not sent.");
    return summary;
  }

  const localNo = await db.getOrgLocalNo().catch(() => "");
  const localTag = localNo ? `AFSCME Local ${localNo}` : "AFSCME Council 31";

  const stepsToNotify = ["step1", "step2", "step3"].filter(s => newlyFiledSteps && newlyFiledSteps[s]);
  for (const step of stepsToNotify) {
    summary.attempted.push(step);
    const subject = `[${localTag}] Grievance Update — ${rec.id} filed at ${STEP_LABELS[step]}`;
    const text = buildStepEmailBody(rec, step, localNo);
    for (const to of recipients) {
      try {
        await sendMail({ apiKey, senderEmail, to, subject, text });
        summary.sent.push({ step, to });
        await db.logEmailAttempt({
          kind: "grievant-update", gid: rec.id, step, to, ok: true
        }).catch(err => console.error("[grievantNotify] Failed to write email log entry:", err.message));
      } catch (err) {
        const detail = err && (err.message || err.code || err.name) || String(err);
        summary.errors.push(`Failed to notify grievant ${to} for ${step}: ${detail}`);
        console.error(`[grievantNotify] Failed to email ${to} for ${rec.id} ${step}:`, err);
        await db.logEmailAttempt({
          kind: "grievant-update", gid: rec.id, step, to, ok: false, error: detail
        }).catch(logErr => console.error("[grievantNotify] Failed to write email log entry:", logErr.message));
      }
    }
  }

  return summary;
}

module.exports = { sendGrievantStepNotifications, buildStepEmailBody, parseEmailList };
