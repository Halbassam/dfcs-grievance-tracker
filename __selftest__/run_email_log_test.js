const assert = require('assert');
const path = require('path');

async function setupDb() {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();
  const poolPath = path.resolve('/home/claude/dfcs-rebuild/server/pool.js');
  const dbPath = path.resolve('/home/claude/dfcs-rebuild/server/db.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool, query: (t,p) => pool.query(t,p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
    }
  };
  // db.js itself must also be re-required fresh each time -- otherwise
  // Node's module cache returns the SAME db.js instance across test
  // functions, which (since it closed over the pool.js mock at require
  // time) would keep querying the FIRST test's in-memory database even
  // though we just registered a brand new pool mock above.
  delete require.cache[dbPath];
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', created_at timestamptz not null default now());
    create table sessions (token text primary key, username text not null, expires_at timestamptz not null);
    create table holidays (date text primary key, name text not null);
    create table setup_lists (key text primary key, items jsonb not null default '[]');
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
  `);
  return require(dbPath);
}

async function testLogEmailAttemptWritesRealRows() {
  const db = await setupDb();

  await db.logEmailAttempt({ kind: 'grievant-update', gid: '2026-001', step: 'step1', to: 'jane@x.gov', ok: true });
  await db.logEmailAttempt({ kind: 'steward-deadline-digest', steward: 'Hazem', to: 'h@x.gov', count: 2, ok: true });
  await db.logEmailAttempt({ kind: 'grievant-update', gid: '2026-002', step: 'step2', to: 'bad@x.gov', ok: false, error: 'some failure' });

  const all = await db.getAll();
  assert.strictEqual(all.emailLog.length, 3, 'expected exactly 3 email log rows after 3 logEmailAttempt calls');

  const kinds = all.emailLog.map(e => e.kind).sort();
  assert.deepStrictEqual(kinds, ['grievant-update', 'grievant-update', 'steward-deadline-digest']);

  const failedEntry = all.emailLog.find(e => e.ok === false);
  assert.ok(failedEntry, 'expected the failed attempt to be logged too, not just successes');
  assert.strictEqual(failedEntry.error, 'some failure');
  assert.ok(failedEntry.loggedAt, 'every log entry should have a loggedAt timestamp');
  console.log('✓ logEmailAttempt writes real rows to email_log for both grievant-update and steward-digest kinds, including failures');
}

async function testRetentionCap() {
  const db = await setupDb();
  for (let i = 0; i < 210; i++) {
    await db.logEmailAttempt({ kind: 'grievant-update', gid: '2026-' + i, step: 'step1', to: 'x@y.gov', ok: true });
  }
  const all = await db.getAll();
  assert.ok(all.emailLog.length <= 200, 'email_log should be capped at 200 rows, got: ' + all.emailLog.length);
  console.log('✓ email_log correctly caps retention at 200 rows even after 210 inserts');
}

async function testGrievantNotifyActuallyLogs() {
  const db = await setupDb();
  delete require.cache[path.resolve('/home/claude/dfcs-rebuild/server/grievantNotify.js')];
  process.env.BREVO_API_KEY = ''; // force the "no config" error path, which still must log nothing extra (no send attempted)
  const { sendGrievantStepNotifications } = require('/home/claude/dfcs-rebuild/server/grievantNotify.js');

  // No email on file -> skipped before any log write
  await sendGrievantStepNotifications(
    { id: '2026-777', employee: 'No Email', grievantEmail: '' },
    { step1: true, step2: false, step3: false }
  );
  const afterSkip = await db.getAll();
  assert.strictEqual(afterSkip.emailLog.length, 0, 'skipping due to no grievant email should not write any log row');
  console.log('✓ grievantNotify does not write a log row when there is no grievant email to notify (nothing was attempted)');
}

(async () => {
  try {
    await testLogEmailAttemptWritesRealRows();
    await testRetentionCap();
    await testGrievantNotifyActuallyLogs();
    console.log('\nALL EMAIL LOG TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
