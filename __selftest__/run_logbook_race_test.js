const assert = require('assert');
const path = require('path');

// Logbook entries are appended to an array stored inside the investigation
// record. The append was built from a copy read before the write, so two
// stewards logging at the same moment could lose one entry.

(async () => {
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
    create table app_meta (key text primary key, value text);
    create table investigations (id text primary key, data jsonb not null, created_at timestamptz not null default now());
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const inv = await db.createInvestigation({ location: 'L1', steward: 'Alice', employee: 'Emp', contactEmail: '', actingUser: 'Alice' });

  // 1. Ten simultaneous entries are all kept.
  const entries = Array.from({ length: 10 }, (_, i) => db.addInvestigationLogEntry(inv.id, { date: '2026-03-01', steward: 'Steward ' + i, entry: 'note ' + i }));
  await Promise.all(entries);
  const stored = (await pool.query('select data from investigations where id=$1', [inv.id])).rows[0].data;
  assert.strictEqual(stored.logbook.length, 10, 'every simultaneous logbook entry must be kept, got ' + stored.logbook.length);
  assert.strictEqual(new Set(stored.logbook.map(e => e.entry)).size, 10);
  console.log('✓ Ten simultaneous logbook entries are all kept');

  // 2. Closing the case still stops new entries, even one that was already in flight.
  await db.closeInvestigation(inv.id, { reason: 'resolved', notes: '' });
  await assert.rejects(db.addInvestigationLogEntry(inv.id, { date: '2026-03-02', steward: 'Late', entry: 'after close' }), /closed/);
  console.log('✓ A closed investigation still refuses new logbook entries');

  console.log('\nALL LOGBOOK RACE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
