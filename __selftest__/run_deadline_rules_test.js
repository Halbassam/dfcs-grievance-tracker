const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

// Deadline rules must agree in the browser and on the server:
// - "overdue" means the next deadline has passed, including the union's own
//   filing deadlines (missing a Step 2 or Step 3 filing waives the grievance);
// - once Step 2 is filed, the Step 1 response deadline stops applying. It used
//   to stay overdue forever on every case that auto-advanced.

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function browserRules() {
  let html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__d = { isOverdue: r => isOverdue(r), nextDeadline: r => nextDeadline(r) };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(window) { window.fetch = (...a) => fetch(...a); } });
  await new Promise(r => setTimeout(r, 300));
  return dom.window.__d;
}

async function browserChecks() {
  const d = await browserRules();

  // A: Step 1 response never recorded, but the case moved on to Step 2 -> not overdue.
  const advanced = { id: 'A', status: 'Pending', step1filed: isoDaysAgo(60), step2filed: isoDaysAgo(1) };
  assert.strictEqual(d.isOverdue(advanced), false, 'a case that advanced to Step 2 must not show a stale Step 1 deadline as overdue');
  // B: union Step 2 filing deadline has passed -> overdue, even though management's Step 1 response was received.
  const missedFiling = { id: 'B', status: 'Pending', step1filed: isoDaysAgo(40), step1resp: isoDaysAgo(35), step2filed: '' };
  assert.strictEqual(d.isOverdue(missedFiling), true, 'a missed Step 2 filing deadline must count as overdue');
  // C: everything on time -> not overdue, and a future next deadline.
  const onTime = { id: 'C', status: 'Pending', step1filed: isoDaysAgo(1) };
  assert.strictEqual(d.isOverdue(onTime), false);
  const nd = d.nextDeadline(onTime);
  assert.ok(nd && nd >= new Date(new Date().setHours(0, 0, 0, 0)), 'a fresh case has a future next deadline');
  // D: a resolved or Step 3 case is never overdue.
  assert.strictEqual(d.isOverdue({ ...missedFiling, status: 'Settled' }), false);
  assert.strictEqual(d.isOverdue({ ...missedFiling, step3filed: isoDaysAgo(2) }), false);
  console.log('✓ Browser: overdue follows the next deadline; a stale Step 1 deadline clears once Step 2 is filed');
}

async function serverRules() {
  const { newDb } = require('pg-mem');
  const pool = new (newDb().adapters.createPg().Pool)();
  const poolPath = path.resolve(__dirname, '..', 'server/pool.js');
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool, query: (t, p) => pool.query(t, p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
    }
  };
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, locked_to text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table holidays (date text primary key, name text not null);
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const put = (id, data) => pool.query(`insert into grievances (id, status, steward, data) values ($1,'Pending','S',$2::jsonb)`,
    [id, JSON.stringify({ id, employee: 'E ' + id, steward: 'S', stewardEmail: 's@x.gov', status: 'Pending', location: 'L1', ...data })]);
  await put('A', { step1filed: isoDaysAgo(60), step2filed: isoDaysAgo(1) });
  await put('B', { step1filed: isoDaysAgo(40), step1resp: isoDaysAgo(35), step2filed: '' });
  const found = await db.findUpcomingDeadlines(3);
  assert.ok(!found.some(f => f.id === 'A' && /Step 1/.test(f.deadlineLabel)), 'the server must not raise a stale Step 1 deadline for a case that advanced');
  const b = found.find(f => f.id === 'B');
  assert.ok(b && b.daysAway < 0 && /filing/.test(b.deadlineLabel), 'the server must flag a missed Step 2 filing deadline as overdue, got: ' + JSON.stringify(b));
  console.log('✓ Server: same rules in the reminder check (no stale Step 1 deadline; missed filing is overdue)');
}

(async () => {
  await browserChecks();
  await serverRules();
  console.log('\nALL DEADLINE RULE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
