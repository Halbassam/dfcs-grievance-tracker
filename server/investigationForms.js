/**
 * Generates self-contained HTML pages for the two public-facing forms
 * served at /intake/:token and /witness/:token. No authentication, no
 * app framework — plain HTML/CSS/JS that works on any phone or computer.
 */

const BRAND_GREEN = "#2c5f3e";

function baseLayout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — FCRC Grievance Tracker</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f3ef;color:#1a2b22;min-height:100vh;}
    .header{background:${BRAND_GREEN};color:#fff;padding:16px 20px;}
    .header h1{font-size:17px;font-weight:600;letter-spacing:.01em;}
    .header p{font-size:12.5px;opacity:.8;margin-top:3px;}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.08);margin:20px auto;max-width:560px;padding:24px;}
    label{display:block;font-size:13px;font-weight:600;color:#2c4a38;margin-bottom:5px;}
    .hint{font-size:12px;color:#6b7c70;margin-bottom:8px;margin-top:-3px;}
    input[type=text],input[type=email],input[type=tel],input[type=date],textarea{
      width:100%;border:1.5px solid #c8d9ce;border-radius:7px;padding:10px 12px;
      font-size:14px;color:#1a2b22;background:#fff;outline:none;transition:border-color .15s;
    }
    input:focus,textarea:focus{border-color:${BRAND_GREEN};}
    textarea{resize:vertical;min-height:90px;}
    .field{margin-bottom:18px;}
    .field:last-child{margin-bottom:0;}
    .btn{display:block;width:100%;background:${BRAND_GREEN};color:#fff;border:none;
      border-radius:8px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;
      margin-top:22px;letter-spacing:.01em;transition:opacity .15s;}
    .btn:disabled{opacity:.55;cursor:not-allowed;}
    .notice{background:#f0f7f3;border:1.5px solid #c3dcc9;border-radius:8px;
      padding:14px 16px;font-size:13px;line-height:1.55;margin-bottom:20px;}
    .notice.amber{background:#fffbf0;border-color:#e8d28a;}
    .notice.red{background:#fdf2f2;border-color:#e8a8a8;color:#7a2020;}
    .err{color:#b93030;font-size:13px;margin-top:6px;}
    .success-box{text-align:center;padding:40px 20px;}
    .success-box .icon{font-size:48px;margin-bottom:16px;}
    .success-box h2{font-size:20px;color:${BRAND_GREEN};margin-bottom:8px;}
    .success-box p{font-size:14px;color:#6b7c70;line-height:1.55;}
    .req{color:#b93030;}
    @media(max-width:400px){.card{margin:12px;padding:18px;}}
  </style>
</head>
<body>
<div class="header">
  <h1>FCRC Grievance Tracker</h1>
  <p>AFSCME Council 31</p>
</div>
${body}
</body>
</html>`;
}

function grievantIntakeForm({ investigation, token }) {
  const inv = investigation;
  const body = `
<div class="card">
  <h2 style="font-size:18px;color:${BRAND_GREEN};margin-bottom:8px;">Employee Statement Form</h2>
  <p style="font-size:13.5px;color:#4a6358;line-height:1.55;margin-bottom:20px;">
    Your union steward is reviewing your workplace concern. Please fill out this form
    as completely as you can — your answers help the steward investigate whether a contract
    violation occurred. This form is confidential and goes only to your steward.
  </p>
  <div class="notice">
    &#128274;&nbsp; You do not need a login to fill out this form. Your information is
    sent securely to your AFSCME steward only.
  </div>
  <form id="intakeForm">
    <div class="field">
      <label for="name">Your full name <span class="req">*</span></label>
      <input type="text" id="name" name="name" required placeholder="First and last name" autocomplete="name">
    </div>
    <div class="field">
      <label for="email">Email address <span class="req">*</span></label>
      <input type="email" id="email" name="email" required placeholder="you@example.com" autocomplete="email">
    </div>
    <div class="field">
      <label for="phone">Phone number</label>
      <div class="hint">Optional — best number for your steward to reach you</div>
      <input type="tel" id="phone" name="phone" placeholder="(555) 555-5555" autocomplete="tel">
    </div>
    <div class="field">
      <label for="incidentDate">Date of the incident <span class="req">*</span></label>
      <input type="date" id="incidentDate" name="incidentDate" required>
    </div>
    <div class="field">
      <label for="description">What happened? <span class="req">*</span></label>
      <div class="hint">Describe the situation in your own words — include who was involved, what was said or done, and where it happened</div>
      <textarea id="description" name="description" required placeholder="Tell us what happened..."></textarea>
    </div>
    <div class="field">
      <label for="witnesses">Were there any witnesses?</label>
      <div class="hint">Names of anyone who saw or heard what happened (optional)</div>
      <input type="text" id="witnesses" name="witnesses" placeholder="e.g. Jane Smith, Bob Jones">
    </div>
    <div class="field">
      <label for="otherDetails">Anything else you want your steward to know?</label>
      <textarea id="otherDetails" name="otherDetails" placeholder="Any other details, context, or questions..."></textarea>
    </div>
    <div id="formErr" class="err" style="display:none;"></div>
    <button type="submit" class="btn" id="submitBtn">Submit my statement</button>
    <p style="font-size:11.5px;color:#9aada2;text-align:center;margin-top:14px;">
      Do not submit this form more than once. Contact your steward if you need to make a correction.
    </p>
  </form>
</div>
<script>
document.getElementById('intakeForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const errEl = document.getElementById('formErr');
  errEl.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Submitting…';
  const data = {
    name: document.getElementById('name').value.trim(),
    email: document.getElementById('email').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    incidentDate: document.getElementById('incidentDate').value,
    description: document.getElementById('description').value.trim(),
    witnesses: document.getElementById('witnesses').value.trim(),
    otherDetails: document.getElementById('otherDetails').value.trim()
  };
  try{
    const res = await fetch('/intake/${token}', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if(!res.ok || json.error) throw new Error(json.error || 'Submission failed.');
    document.getElementById('intakeForm').parentElement.innerHTML = \`
      <div class="success-box">
        <div class="icon">&#10003;</div>
        <h2>Statement received</h2>
        <p>Thank you, \${data.name.split(' ')[0]}. Your statement has been sent to your steward. They will be in touch if they have follow-up questions.</p>
      </div>\`;
  }catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Submit my statement';
  }
});
</script>`;
  return baseLayout({ title: "Employee Statement", body });
}

function errorPage({ title, message }) {
  const body = `
<div class="card">
  <div class="notice red">
    <strong>${title}</strong><br>${message}
  </div>
  <p style="font-size:13px;color:#6b7c70;margin-top:14px;">
    If you believe you received this link by mistake, please contact your AFSCME steward directly.
  </p>
</div>`;
  return baseLayout({ title, body });
}

module.exports = { grievantIntakeForm, errorPage };
