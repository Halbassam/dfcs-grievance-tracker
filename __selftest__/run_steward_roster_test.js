const assert = require('assert');
const path = require('path');

// A steward is now a user record: name, email, login (optional) and whether
// they appear in the steward lists. The steward lists the app reads are
// derived from those records. Checked here against the real db.js, with
// pg-mem as the database.

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
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', locations jsonb not null default '[]', email text not null default '', is_steward boolean not null default false, created_at timestamptz not null default now());
    create table grievances (id text primary key, status text not null default 'Pending', steward text, locked_to text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table holidays (date text primary key, name text not null);
    create table setup_lists (key text primary key, items jsonb not null default '[]');
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
    create table attachments (id text primary key, gid text not null, filename text not null, content_type text not null, size_bytes integer not null, storage_path text not null, uploaded_by text not null, uploaded_at timestamptz not null default now());
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const { findStewardEmail } = require(path.resolve(__dirname, '..', 'server/handoffNotify.js'));
  const roster = async () => {
    const all = await db.getAll();
    return { names: all.setup.Steward, emails: all.setup.StewardEmail, users: all.users };
  };

  // 1. A steward with no login: in the steward list, with their email, and cannot sign in.
  await db.upsertUser({ username: 'alice', displayName: 'Alice Ward', isSteward: true, email: 'alice@x.gov' });
  let r = await roster();
  assert.deepStrictEqual(r.names, ['Alice Ward']);
  assert.deepStrictEqual(r.emails, ['alice@x.gov']);
  assert.strictEqual(await db.verifyLogin('alice', 'anything'), null, 'a steward with no login cannot sign in');
  console.log('✓ A steward can be set up with no login: listed with their email, and cannot sign in');

  // 2. Creating someone who is neither a steward nor has a password is still refused.
  await assert.rejects(db.upsertUser({ username: 'nobody', displayName: 'No Body' }), /password is required/);
  console.log('✓ A new account needs a password unless it is a steward');

  // 3. A read-only account can also be a steward.
  await db.upsertUser({ username: 'rita', displayName: 'Rita Ortiz', password: 'ritapass12', role: 'read_only', isSteward: true, email: 'rita@x.gov', locations: ['L1'] });
  r = await roster();
  assert.ok(r.names.includes('Rita Ortiz'), 'a read-only steward is in the steward list');
  const rita = r.users.find(u => u.username === 'rita');
  assert.strictEqual(rita.role, 'read_only');
  assert.strictEqual(rita.isSteward, true);
  console.log('✓ A read-only account can also be a steward');

  // 4. A person who is not a steward is not in the list; emails stay with their own people.
  await db.upsertUser({ username: 'boss', displayName: 'Boss Person', password: 'bosspass12', role: 'admin' });
  await db.upsertUser({ username: 'dan', displayName: 'Dan Lee', isSteward: true, email: '' });
  await db.upsertUser({ username: 'erin', displayName: 'Erin Park', isSteward: true, email: 'erin@x.gov' });
  r = await roster();
  assert.ok(!r.names.includes('Boss Person'), 'a non-steward is not in the steward list');
  const dIdx = r.names.indexOf('Dan Lee'), eIdx = r.names.indexOf('Erin Park');
  assert.strictEqual(r.emails[dIdx], '', 'a steward without an email stays blank');
  assert.strictEqual(r.emails[eIdx], 'erin@x.gov', 'the next steward keeps their own email');
  console.log('✓ Stewards without an email do not shift anyone else\'s');

  // 5. Hand-off emails go to the email on the receiver\'s own record.
  const erin = r.users.find(u => u.username === 'erin');
  assert.strictEqual(await findStewardEmail(erin), 'erin@x.gov');
  assert.strictEqual(await findStewardEmail(r.users.find(u => u.username === 'dan')), '');
  console.log('✓ Hand-off emails use the email on the receiver\'s record');

  // 6. Changing an email, without a password, keeps the login working.
  await db.upsertUser({ username: 'rita', displayName: 'Rita Ortiz', role: 'read_only', isSteward: true, email: 'rita.ortiz@x.gov' });
  r = await roster();
  assert.strictEqual(r.emails[r.names.indexOf('Rita Ortiz')], 'rita.ortiz@x.gov');
  assert.ok(await db.verifyLogin('rita', 'ritapass12'), 'the login is kept when only the email changes');
  console.log('✓ Changing a steward\'s email keeps their login');

  // 7. Removing steward status takes them out of the list without deleting the account.
  await db.upsertUser({ username: 'erin', displayName: 'Erin Park', isSteward: false });
  r = await roster();
  assert.ok(!r.names.includes('Erin Park'));
  assert.ok(r.users.some(u => u.username === 'erin'), 'the account still exists');
  console.log('✓ Removing steward status keeps the account');

  console.log('\nALL STEWARD ROSTER TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
