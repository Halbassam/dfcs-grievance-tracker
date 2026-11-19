const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

// Browser-side fixes, checked against the real page:
// 1. background refresh starts after a sign-in through the form (it only
//    started on a page load, so a fresh sign-in went stale);
// 2. a 401 during a refresh returns to the sign-in screen instead of saying
//    "the server may be waking up";
// 3. signing out clears the half-entered intake case;
// 4. the archive count matches the cases the server will actually archive;
// 5. CSV cells that start with = + - @ can't run as formulas in Excel;
// 6. an investigation's statement shows in full, with its phone, witnesses and
//    other details.

async function load(opts) {
  let html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__u = {
      refresh: () => refresh(true),
      attemptLogin: () => attemptLogin(),
      setState: s => { STATE = s; },
      setUser: u => { CURRENT_USER = u; },
      csvCell: v => csvCell(v),
      renderInvestigationDetail: i => renderInvestigationDetail(i)
    };
  </script>`);
  const intervals = [];
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(window) {
      const realSetInterval = window.setInterval;
      window.setInterval = (fn, ms, ...rest) => { intervals.push(ms); return realSetInterval(fn, ms, ...rest); };
      window.fetch = async (url, init = {}) => {
        calls.push(url);
        const reply = (status, json) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });
        if (url === '/api/auth/session') return reply(401, { error: 'Not logged in.' });
        if (url === '/api/auth/login') return reply(200, { ok: true, user: { username: 'alice', displayName: 'Alice', role: 'steward', locations: ['L1'] } });
        if (url === '/api/auth/logout') return reply(200, { ok: true });
        if (url === '/api/data') return opts.dataStatus === 401 ? reply(401, { error: 'Login required.' }) : reply(200, {});
        return reply(200, {});
      };
    }
  });
  await new Promise(r => setTimeout(r, 300));
  return { w: dom.window, intervals, calls };
}

(async () => {
  // 1. Polling after a form sign-in.
  {
    const { w, intervals } = await load({});
    w.document.getElementById('loginUsername').value = 'alice';
    w.document.getElementById('loginPassword').value = 'alicepass1';
    await w.__u.attemptLogin();
    assert.ok(intervals.includes(15000), 'background refresh must start after signing in through the form');
    console.log('✓ Background refresh starts after a sign-in through the form');
  }

  // 2. A 401 during a refresh returns to sign-in.
  {
    const { w } = await load({ dataStatus: 401 });
    w.document.getElementById('loginScreen').classList.add('hidden');
    w.document.getElementById('mainApp').classList.remove('hidden');
    await w.__u.refresh();
    assert.ok(!w.document.getElementById('loginScreen').classList.contains('hidden'), 'an expired session must show the sign-in screen');
    assert.ok(!/waking up/.test(w.document.getElementById('connBanner').textContent), 'an expired session must not say the server is waking up');
    console.log('✓ An expired session during a refresh returns to the sign-in screen');
  }

  // 3. Signing out clears the intake draft.
  {
    const { w } = await load({});
    w.document.getElementById('f-gid').value = 'G-DRAFT';
    w.document.getElementById('f-name').value = 'Draft Person';
    w.document.getElementById('logoutBtn').click();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(w.document.getElementById('f-name').value, '', 'signing out must clear the half-entered case');
    assert.strictEqual(w.document.getElementById('f-gid').value, '');
    console.log('✓ Signing out clears the half-entered intake case');
  }

  // 4. The archive count only includes cases this user can archive.
  {
    const { w } = await load({});
    w.__u.setUser({ username: 'alice', displayName: 'Alice', role: 'steward', locations: ['L1'] });
    w.__u.setState({ grievances: [
      { id: 'R1', status: 'Settled', lockedTo: 'alice' },
      { id: 'R2', status: 'Settled', lockedTo: 'bob' },
      { id: 'R3', status: 'Granted', lockedTo: '' }
    ], activity: [], archive: [], holidays: [], attachments: [], users: [] });
    w.document.getElementById('archiveClosedBtn').click();
    const body = w.document.getElementById('archiveModalBody').textContent;
    assert.ok(/move\s*2\s*grievance/.test(body), 'two cases are archivable here (its own and the unlocked one), got: ' + body);
    console.log('✓ The archive count leaves out cases locked to someone else');
  }

  // 5. CSV formula injection.
  {
    const { w } = await load({});
    const cell = v => w.__u.csvCell(v);
    assert.ok(!cell('=HYPERLINK("http://evil.example")').startsWith('='), 'a formula cell must not start with =');
    assert.ok(cell('=HYPERLINK("http://evil.example")').startsWith('"\'='), 'a formula cell must be prefixed as text');
    assert.ok(cell('+1-555').startsWith("'+"), 'a cell starting with + must be prefixed');
    assert.ok(cell('@sum(A1)').startsWith("'@"), 'a cell starting with @ must be prefixed');
    assert.strictEqual(cell('Smith, Jane'), '"Smith, Jane"', 'ordinary cells are unchanged apart from quoting');
    assert.strictEqual(cell('Art. IX Sec. 2'), 'Art. IX Sec. 2');
    assert.ok(cell('line one\rline two').startsWith('"'), 'a cell with a carriage return must be quoted');
    console.log('✓ CSV cells that look like formulas are neutralised; ordinary cells are unchanged');
  }

  // 6. The investigation statement is complete, with phone, witnesses and other details.
  {
    const { w } = await load({});
    const long = 'A'.repeat(220) + ' END-OF-STATEMENT';
    w.__u.renderInvestigationDetail({
      id: 'INV-1', employee: 'Pat', location: 'L1', steward: 'Alice', status: 'open',
      contactEmail: '', contactPhone: '', incidentDescription: '', incidentDates: '', logbook: [], witnessStatements: [],
      grievantSubmission: { submittedAt: '2026-05-01T00:00:00Z', data: {
        name: 'Pat', email: 'pat@x.gov', phone: '555-0100', incidentDate: '2026-04-30',
        description: long, witnesses: 'Jo Smith', otherDetails: 'Also the badge reader'
      } }
    });
    const shown = w.document.getElementById('invGrievantSubmission').textContent;
    assert.ok(shown.includes('555-0100'), 'the phone number must be shown');
    assert.ok(shown.includes('Jo Smith'), 'the witnesses must be shown');
    assert.ok(shown.includes('Also the badge reader'), 'the other details must be shown');
    assert.ok(shown.includes('END-OF-STATEMENT'), 'the statement must not be cut short');
    console.log('✓ The investigation statement shows in full, with phone, witnesses and other details');
  }

  console.log('\nALL CLIENT UX TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
