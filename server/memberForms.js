/**
 * Public pages for the shared contact link (/contact/:token).
 * No login, and the link is not personal. A person enters their own details.
 * Plain HTML, works on a phone. Values are escaped.
 */

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BRAND_GREEN = "#00421e";

function page({ title, body, localNo }) {
  const headerName = localNo ? `AFSCME Council 31 &middot; Local ${esc(localNo)}` : "AFSCME Council 31";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — AFSCME Council 31</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    [hidden]{display:none!important;}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f3ef;color:#1a2b22;min-height:100vh;}
    .header{background:${BRAND_GREEN};color:#fff;padding:16px 20px;}
    .header h1{font-size:17px;font-weight:600;}
    .header p{font-size:12.5px;opacity:.8;margin-top:3px;}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.08);margin:20px auto;width:calc(100% - 32px);max-width:560px;padding:24px;}
    .card h2{font-size:18px;color:${BRAND_GREEN};margin-bottom:12px;}
    .notice{background:#eef4f7;border:1px solid #c5d8e6;border-radius:8px;padding:12px 14px;font-size:13.5px;line-height:1.5;margin-bottom:18px;}
    label{display:block;font-size:13px;font-weight:600;color:#2c4a38;margin:14px 0 5px;}
    .hint{font-size:12px;color:#6b7c70;margin-top:4px;}
    input[type=text],input[type=email],input[type=tel]{width:100%;font-size:15px;padding:10px 12px;border:1px solid #cdd3d8;border-radius:8px;background:#fff;}
    input:focus{outline:none;border-color:#005daa;box-shadow:0 0 0 3px rgba(0,93,170,.18);}
    .check{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px;margin-top:18px;}
    .check input{margin-top:3px;width:18px;height:18px;flex-shrink:0;}
    button{margin-top:18px;width:100%;background:#005daa;color:#fff;border:none;border-radius:8px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;}
    button:disabled{opacity:.6;cursor:default;}
    .err{background:#fdeceb;border:1px solid #e3a8a5;color:#9c0006;border-radius:8px;padding:10px 12px;font-size:13.5px;margin-top:14px;}
    .muted{color:#5f6f64;font-size:14px;line-height:1.5;}
    .trap{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
    .credit{max-width:560px;margin:0 auto 32px;padding:0 16px;font-size:12px;color:#5f6f64;text-align:center;line-height:1.5;}
  </style>
</head>
<body>
  <div class="header"><h1>${headerName}</h1><p>Member contact details</p></div>
  ${body}
</body>
</html>`;
}

/** The form anyone with the link can fill in. `locations` is the existing location list. */
function contactForm({ locations, token, localNo, mode }) {
  const heading = mode === "update" ? "Update your contact details" : "Your contact details";
  const options = (locations || []).map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  return page({
    title: "Your contact details",
    localNo,
    body: `<div class="card">
  <h2>${esc(heading)}</h2>
  <div class="notice"><b>How your details will be used.</b> The union uses these details to contact you about union business. Only union stewards can see them. Sharing them is voluntary. They are kept until you ask the union to delete them. You can ask your steward to change or remove them at any time.</div>

  <form id="f" novalidate>
    <div id="formFields">
      <label for="location">Your location</label>
      <select id="location" required style="width:100%;font-size:15px;padding:10px 12px;border:1px solid #cdd3d8;border-radius:8px;background:#fff;">
        <option value="">Choose your location</option>${options}
      </select>

      <label for="legalName">Legal name</label>
      <input type="text" id="legalName" autocomplete="name" maxlength="120" required>

      <label for="phone">Phone number</label>
      <input type="tel" id="phone" autocomplete="tel" placeholder="(312) 555-0100">

      <label for="personalEmail">Personal email</label>
      <input type="email" id="personalEmail" autocomplete="email" maxlength="254">

      <label for="stateEmail">State email</label>
      <input type="email" id="stateEmail" autocomplete="email" maxlength="254">
      <p class="hint">Enter at least a phone number or one email address.</p>

      <input type="text" id="website" class="trap" tabindex="-1" autocomplete="off" aria-hidden="true">

      <label class="check"><input type="checkbox" id="consent"> <span>I agree that the union may use these details to contact me about union business.</span></label>

      <label class="check"><input type="checkbox" id="newsletter"> <span>I would like to receive union newsletters by email. This is optional. You can unsubscribe at any time.</span></label>
    </div>
    <div id="err" class="err" hidden></div>
    <button id="go" type="submit">Save my details</button>
  </form>

  <div id="done" hidden>
    <h2>Thank you</h2>
    <p class="muted">Your details have been saved.</p>
  </div>
</div>
<script>
(function(){
  var form = document.getElementById('f');
  var err = document.getElementById('err');
  var btn = document.getElementById('go');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    err.hidden = true;
    var body = {
      location: document.getElementById('location').value,
      legalName: document.getElementById('legalName').value,
      phone: document.getElementById('phone').value,
      personalEmail: document.getElementById('personalEmail').value,
      stateEmail: document.getElementById('stateEmail').value,
      consent: document.getElementById('consent').checked,
      newsletter: document.getElementById('newsletter').checked,
      website: document.getElementById('website').value
    };
    btn.disabled = true;
    fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(data){ return { ok: res.ok, data: data }; }); })
      .then(function(r){
        if (!r.ok) { err.textContent = r.data.error || 'Could not save. Please try again.'; err.hidden = false; btn.disabled = false; return; }
        form.hidden = true; document.getElementById('done').hidden = false;
      })
      .catch(function(){ err.textContent = 'Could not reach the server. Please try again.'; err.hidden = false; btn.disabled = false; });
  });
})();
</script>
<div class="credit">Developed by Hazem Albassam &middot; &copy; 2026</div>`
  });
}

/** The page behind the unsubscribe link. A button does the unsubscribing. */
function unsubscribePage({ token }) {
  return page({
    title: "Unsubscribe",
    body: `<div class="card">
  <h2 id="t">Unsubscribe from newsletters</h2>
  <p class="muted" id="m">Press the button to stop receiving union newsletters at this address.</p>
  <button id="go" type="button">Unsubscribe</button>
  <div id="err" class="err" hidden></div>
</div>
<script>
(function(){
  document.getElementById('go').addEventListener('click', function(){
    var btn = this; btn.disabled = true;
    fetch(location.pathname, { method: 'POST' })
      .then(function(res){ if (!res.ok) throw new Error('not found'); return res.json(); })
      .then(function(){
        document.getElementById('t').textContent = 'You have been unsubscribed';
        document.getElementById('m').textContent = 'You will not receive union newsletters at this address. Your steward can help if you change your mind.';
        btn.hidden = true;
      })
      .catch(function(){
        var e = document.getElementById('err');
        e.textContent = 'This link is not valid, or something went wrong. Please try again or contact your steward.';
        e.hidden = false; btn.disabled = false;
      });
  });
})();
</script>`
  });
}

function messagePage({ title, message }) {
  return page({
    title,
    body: `<div class="card"><h2>${esc(title)}</h2><p class="muted">${esc(message)}</p></div>`
  });
}

module.exports = { contactForm, messagePage, unsubscribePage, esc };
