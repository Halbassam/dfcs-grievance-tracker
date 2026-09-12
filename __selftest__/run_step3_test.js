const assert = require('assert');
const path = require('path');

async function testBackend() {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();
  const poolPath = path.resolve('/home/claude/dfcs-rebuild/server/pool.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool, query: (t,p) => pool.query(t,p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
    }
  };
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table holidays (date text primary key, name text not null);
  `);
  const db = require('/home/claude/dfcs-rebuild/server/db.js');

  const today = new Date();
  function iso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  const longAgo = new Date(today); longAgo.setDate(longAgo.getDate() - 200);

  // A grievance filed at Step 3 a long time ago, with no Step 3 response —
  // under the OLD logic this would be wildly overdue and alert every day.
  await pool.query(
    `insert into grievances (id, status, steward, data) values ($1,$2,$3,$4::jsonb)`,
    ['2026-777', 'Pending', 'Hazem', JSON.stringify({
      id: '2026-777', employee: 'Step3 Test', steward: 'Hazem', stewardEmail: 'h@x.gov',
      status: 'Pending',
      step1filed: iso(longAgo), step1resp: iso(longAgo),
      step2filed: iso(longAgo), step2resp: iso(longAgo),
      step3filed: iso(longAgo) // filed at step 3, no response yet — 200 days ago
    })]
  );

  const result = await db.findUpcomingDeadlines(9999); // huge window — should still find nothing
  const hit = result.find(r => r.id === '2026-777');
  assert.strictEqual(hit, undefined, 'a grievance filed at Step 3 must generate NO deadline alert, even with an enormous window');
  console.log('✓ Backend: no alert generated once Step 3 is filed, regardless of how overdue it would otherwise be');
}

async function testFrontend() {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  let html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__t2 = {
      rowClass: (r)=>rowClass(r), isOverdue: (r)=>isOverdue(r), nextDeadline: (r)=>nextDeadline(r)
    };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));

  const rec = {
    id: '2026-777', employee: 'Step3 Test', status: 'Pending',
    step1filed: '2025-01-01', step1resp: '2025-01-05',
    step2filed: '2025-01-10', step2resp: '2025-01-20',
    step3filed: '2025-02-01' // filed long ago, no response
  };

  assert.strictEqual(w.__t2.rowClass(rec), 'row-blue', 'expected row-blue once Step 3 is filed, got: ' + w.__t2.rowClass(rec));
  assert.strictEqual(w.__t2.isOverdue(rec), false, 'a Step-3-filed grievance must not be flagged overdue by this system anymore');
  assert.strictEqual(w.__t2.nextDeadline(rec), null, 'a Step-3-filed grievance must have no tracked next deadline');
  console.log('✓ Frontend: rowClass returns row-blue, isOverdue is false, nextDeadline is null once Step 3 is filed');

  // Confirm a resolved grievance still shows green even if step3filed is set
  const resolvedRec = { ...rec, status: 'Settled' };
  assert.strictEqual(w.__t2.rowClass(resolvedRec), 'row-green', 'resolved should stay green even with step3filed set');
  console.log('✓ Frontend: resolved status still takes priority over the blue Step 3 styling');

  // Confirm the CSS class actually has blue background + white text
  const styleText = [...w.document.querySelectorAll('style')].map(s=>s.textContent).join('\n');
  assert.ok(/row-blue\s*\{[^}]*background:\s*#1a4fa0/.test(styleText), 'row-blue must have the blue background color');
  assert.ok(/row-blue\s*\{[^}]*color:\s*#fff/.test(styleText), 'row-blue must have white text color');
  console.log('✓ CSS: .row-blue has blue background (#1a4fa0) and white text (#fff)');
}

(async () => {
  try {
    await testBackend();
    await testFrontend();
    console.log('\nALL STEP-3 TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();

// Extra check: due-within-7-days rows are now true yellow, not the old amber
(async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  const html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');
  const dom = new JSDOM(html);
  const styleText = [...dom.window.document.querySelectorAll('style')].map(s=>s.textContent).join('\n');
  const assert = require('assert');
  assert.ok(/row-amber\s*\{[^}]*background:\s*#fff3b0/i.test(styleText), 'row-amber must use the new yellow (#fff3b0)');
  console.log('✓ CSS: .row-amber (due within 7 days) now uses yellow (#fff3b0)');
})();
