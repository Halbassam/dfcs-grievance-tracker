const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

// The intake form lost data in four ways, all checked here against the real
// page with the network stubbed (so we see exactly what it sends):
// 1. a saved dropdown value removed from its list was blanked on the next save;
// 2. a steward removed from the roster lost their saved email address;
// 3. an assigned grievance number that wasn't used was discarded, not returned;
// 4. a number was lost when the page was closed;
// 5. a failed activity note made the whole (successful) save look failed.

(async () => {
  let html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__f = {
      loadIntoForm: r => loadIntoForm(r),
      submitAndClear: () => submitAndClear(),
      setPending: n => { _pendingPoolNumber = n; },
      setState: s => { STATE = s; },
      setSetup: s => { SETUP = s; }
    };
    window.refresh = async () => {};
  </script>`);

  let activityFails = false;
  let calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(window) {
      window.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url, body, keepalive: !!init.keepalive });
        const reply = (status, json) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });
        if (url === '/api/grievance') return reply(200, { isNew: false, record: { ...body } , newlyFiledSteps: {} });
        if (url === '/api/activity') return activityFails ? reply(500, { error: 'activity store is down' }) : reply(200, { ok: true });
        if (url === '/api/grievance-pool/return') return reply(200, { ok: true, remaining: 1 });
        return reply(200, {});
      };
    }
  });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));
  const toasts = () => w.document.getElementById('toastStack').textContent;
  const setOptions = (id, values) => {
    const el = w.document.getElementById(id);
    el.innerHTML = values.map(v => `<option value="${v}">${v}</option>`).join('');
  };
  const reset = () => { calls = []; w.document.getElementById('toastStack').innerHTML = ''; };
  const submitCalls = () => calls.filter(c => c.url === '/api/grievance');

  setOptions('f-status', ['Pending', 'Granted']);
  setOptions('f-steward', ['Alice', 'Bob']);
  w.__f.setSetup({ Steward: ['Alice', 'Bob'], StewardEmail: ['alice@x.gov', 'bob@x.gov'], Status: ['Pending', 'Granted'] });

  // 1 + 2: editing a case whose status and steward are no longer in the lists keeps them.
  const saved = { id: 'G-1', employee: 'Jane', status: 'Old Status', steward: 'Former Steward', stewardEmail: 'former@x.gov', step1filed: '2026-06-01' };
  w.__f.setState({ grievances: [saved], activity: [], archive: [], holidays: [], attachments: [], users: [] });
  w.__f.loadIntoForm(saved);
  assert.strictEqual(w.document.getElementById('f-status').value, 'Old Status', 'the saved status must still be selected in the form');
  await w.__f.submitAndClear();
  const sent = submitCalls()[0].body;
  assert.strictEqual(sent.status, 'Old Status', 'saving must not blank a status that was removed from the list, sent: ' + sent.status);
  assert.strictEqual(sent.stewardEmail, 'former@x.gov', 'a steward removed from the roster must keep their saved email, sent: ' + sent.stewardEmail);
  console.log('✓ A removed status and a removed steward survive an edit and save');

  // 3 + 4: an assigned number that wasn't used goes back to the pool, including when the page closes.
  reset();
  w.__f.setState({ grievances: [], activity: [], archive: [], holidays: [], attachments: [], users: [] });
  w.__f.setPending('P-9');
  w.document.getElementById('f-gid').value = 'G-OTHER';
  w.document.getElementById('f-name').value = 'Pat';
  w.document.getElementById('f-steward').value = 'Alice';
  await w.__f.submitAndClear();
  const returned = calls.filter(c => c.url === '/api/grievance-pool/return');
  assert.strictEqual(returned.length, 1, 'an assigned number that was not used must be returned to the pool');
  assert.strictEqual(returned[0].body.number, 'P-9');
  console.log('✓ An assigned number not used for the saved grievance goes back to the pool');

  reset();
  w.__f.setPending('P-7');
  w.dispatchEvent(new w.Event('pagehide'));
  await new Promise(r => setTimeout(r, 20));
  const onClose = calls.find(c => c.url === '/api/grievance-pool/return');
  assert.ok(onClose && onClose.body.number === 'P-7', 'an assigned number must be returned when the page closes');
  assert.strictEqual(onClose.keepalive, true, 'the close-time return must be allowed to finish after the page unloads');
  console.log('✓ An assigned number is returned when the page closes');

  // 5: a failed activity note doesn't turn the save into a failure.
  reset();
  activityFails = true;
  w.__f.setPending(null);
  w.document.getElementById('f-gid').value = 'G-2';
  w.document.getElementById('f-name').value = 'Sam';
  await w.__f.submitAndClear();
  activityFails = false;
  assert.ok(submitCalls().length === 1, 'the grievance is saved');
  assert.ok(toasts().includes('Grievance G-2 added.'), 'the success message must still show: ' + toasts());
  assert.ok(toasts().includes('activity note did not save'), 'the failed note must be reported on its own: ' + toasts());
  assert.ok(!/could not save/i.test(toasts()), 'a successful save must not be reported as failed: ' + toasts());
  console.log('✓ A failed activity note is reported separately from a successful save');

  console.log('\nALL FORM DATA TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
