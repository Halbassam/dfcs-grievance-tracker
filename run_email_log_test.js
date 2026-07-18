const assert = require('assert');
const path = require('path');

(async () => {
  // This test's real value comes from running when the container's own
  // clock is UTC and it's evening in Central time (a very common state
  // for Render, which always runs UTC) -- the exact conditions that
  // caused "today" to be miscalculated as tomorrow.
  const utcNow = new Date();
  const utcDateStr = utcNow.toISOString().slice(0, 10);

  const chicagoFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = chicagoFmt.formatToParts(utcNow);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const chicagoDateStr = `${map.year}-${map.month}-${map.day}`;

  console.log(`  (container clock UTC date: ${utcDateStr}, actual Chicago date: ${chicagoDateStr})`);

  // ---------- Test db.js's todayInChicago() ----------
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

  // Grievance whose Step 2 filing deadline is exactly "today" in Chicago
  // time. If the server used raw UTC "today" during an evening-Central
  // moment where UTC has already rolled to the next day, this deadline
  // would incorrectly be excluded (or miscounted) instead of showing
  // daysAway === 0.
  const chicagoToday = new Date(Number(map.year), Number(map.month) - 1, Number(map.day));
  function iso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  // Work backward: step2FilingDue = step1resp + 5 working days. Use a
  // wide berth (7 calendar days back) so weekends can't push it off today
  // exactly -- instead we just confirm it's found and daysAway is sane
  // relative to the CORRECT (Chicago) today, not a UTC-shifted one.
  const respDate = new Date(chicagoToday); respDate.setDate(respDate.getDate() - 7);

  await pool.query(
    `insert into grievances (id, status, steward, data) values ($1,$2,$3,$4::jsonb)`,
    ['2026-tz1', 'Pending', 'Hazem', JSON.stringify({
      id: '2026-tz1', employee: 'TZ Test', steward: 'Hazem', stewardEmail: 'h@x.gov',
      status: 'Pending', step1filed: iso(new Date(chicagoToday.getFullYear(), chicagoToday.getMonth(), chicagoToday.getDate()-20)),
      step1resp: iso(respDate)
    })]
  );

  const result = await db.findUpcomingDeadlines(10);
  const hit = result.find(r => r.id === '2026-tz1');
  assert.ok(hit, 'expected the test grievance to appear in results');

  // The critical assertion: daysAway must be computed relative to the
  // ACTUAL Chicago calendar date, not a UTC date that may already be
  // one day ahead. We verify this indirectly: if the bug were present
  // and it's currently evening Central (UTC already next day), daysAway
  // would be systematically off by exactly 1 compared to the correct
  // Chicago-relative calculation.
  const deadlineDate = new Date(hit.deadlineDate + 'T00:00:00');
  const expectedDaysAway = Math.round((deadlineDate - chicagoToday) / 86400000);
  assert.strictEqual(hit.daysAway, expectedDaysAway,
    `daysAway (${hit.daysAway}) must match the Chicago-relative calculation (${expectedDaysAway}) -- a mismatch here means the old UTC-based bug is back`);
  console.log("✓ findUpcomingDeadlines computes daysAway relative to the correct Chicago calendar date, not the server's raw UTC clock");

  // ---------- Direct comparison: if the container is UTC and it's already
  // "tomorrow" in UTC relative to Chicago, prove the two dates differ AND
  // that our fixed code picks the Chicago one, not the UTC one. ----------
  if (utcDateStr !== chicagoDateStr) {
    console.log(`  (this run genuinely exercised the bug condition: UTC date ${utcDateStr} \u2260 Chicago date ${chicagoDateStr})`);
  } else {
    console.log('  (UTC and Chicago dates happen to match at this moment -- the fix is still correct, just not stress-tested by real skew right now)');
  }

  console.log('\nALL TIMEZONE TESTS PASSED');
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
