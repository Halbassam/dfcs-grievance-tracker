const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const fs = require('fs');

// Dates and activity dates come from the server and were written into the page
// unescaped, and toast() built its text as markup. A steward who saved a date
// containing markup could run script for every admin and location-mate who
// opened the grievance log. Each of these must render as plain text.

(async () => {
  let html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__x = {
      setState: (s) => { STATE = s; },
      renderLog: () => renderLog(),
      renderActivity: () => renderActivity(),
      openDetail: (gid) => openDetail(gid),
      toast: (m, t) => toast(m, t)
    };
  </script>`);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(window) { window.fetch = (...args) => fetch(...args); }
  });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));

  const payload = '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
  w.__x.setState({
    grievances: [{
      id: '2026-x1', employee: 'Jane', steward: 'Hazem', status: 'Pending',
      awareness: payload, step1filed: payload, step1resp: payload, step2filed: payload,
      step2resp: payload, step3filed: payload, step3resp: payload, step4filed: payload
    }],
    activity: [{ id: 'a1', gid: '2026-x1', date: payload, followupDate: payload, followup: 'Yes', type: 'Note', notes: 'ok' }],
    archive: [], holidays: [], attachments: []
  });

  w.__x.renderLog();
  w.__x.renderActivity();
  w.__x.openDetail('2026-x1');
  w.__x.toast('Assigned: ' + payload + ' — only 2 number(s) left', 'err');
  await new Promise(r => setTimeout(r, 50));

  for (const [where, root] of [
    ['grievance log', w.document.getElementById('logBody')],
    ['activity list', w.document.getElementById('activityList')],
    ['detail view', w.document.getElementById('detailBody')],
    ['toast', w.document.getElementById('toastStack')]
  ]) {
    assert.ok(root, 'missing ' + where);
    assert.strictEqual(root.querySelectorAll('img').length, 0, 'the ' + where + ' must not contain injected markup');
  }
  assert.strictEqual(w.__pwned, undefined, 'injected script must not run');
  const logText = w.document.getElementById('logBody').textContent;
  assert.ok(logText.includes('<img'), 'the value should still be visible as text, not silently dropped');
  console.log('✓ Dates, activity dates and toast messages are shown as text, and injected script does not run');

  console.log('\nALL XSS RENDER TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
