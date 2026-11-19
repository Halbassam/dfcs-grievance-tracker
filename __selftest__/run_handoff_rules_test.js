const assert = require('assert');
const path = require('path');
const http = require('http');

// A hand-off moves the lock on a grievance to another user. It used to accept
// any existing account, including a read-only account (who can't edit the
// case) and a steward at another location (who can't even see it), leaving the
// grievance stuck with someone who can't work it. An unlocked grievance could
// also not be handed off at all, even by its own steward.

function request(port, method, pathname, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

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
    create table grievances (id text primary key, status text not null default 'Pending', steward text, locked_to text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', locations jsonb not null default '[]', email text not null default '', is_steward boolean not null default false, created_at timestamptz not null default now());
    create table sessions (token text primary key, username text not null, expires_at timestamptz not null);
    create table holidays (date text primary key, name text not null);
    create table setup_lists (key text primary key, items jsonb not null default '[]');
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
    create table attachments (id text primary key, gid text not null, filename text not null, content_type text not null, size_bytes integer not null, storage_path text not null, uploaded_by text not null, uploaded_at timestamptz not null default now());
    create table audit_log (id serial primary key, username text not null, action text not null, detail text not null default '', ip text not null default '', created_at timestamptz not null default now());
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  await db.upsertUser({ username: 'boss', displayName: 'Boss', password: 'bosspass1' });
  await db.upsertUser({ username: 'alice', displayName: 'Alice', password: 'alicepass1', role: 'steward', locations: ['L1'] });
  await db.upsertUser({ username: 'carl', displayName: 'Carl', password: 'carlpass12', role: 'steward', locations: ['L1'] });
  await db.upsertUser({ username: 'dana', displayName: 'Dana', password: 'danapass12', role: 'steward', locations: ['L1'] });
  await db.upsertUser({ username: 'eve', displayName: 'Eve', password: 'evepass123', role: 'steward', locations: ['L2'] });
  await db.upsertUser({ username: 'viewer', displayName: 'Viewer', password: 'viewerpw12', role: 'read_only', locations: ['L1'] });
  // An older, unlocked grievance (lock never set) at L1.
  await pool.query(`insert into grievances (id, status, steward, locked_to, data) values ('G-LEG', 'Pending', 'Alice', null, '{"id":"G-LEG","location":"L1","employee":"Legacy"}')`);

  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const login = async (u, p) => {
    const r = await request(port, 'POST', '/api/auth/login', { body: { username: u, password: p } });
    assert.strictEqual(r.status, 200, `login ${u} failed`);
    return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
  };
  const T = {
    boss: await login('boss', 'bosspass1'),
    alice: await login('alice', 'alicepass1'),
    carl: await login('carl', 'carlpass12'),
    dana: await login('dana', 'danapass12'),
    eve: await login('eve', 'evepass123'),
    viewer: await login('viewer', 'viewerpw12')
  };
  const lockedTo = async gid => (await pool.query('select locked_to from grievances where id=$1', [gid])).rows[0].locked_to;
  const handoff = (who, gid, toUsername) => request(port, 'POST', '/api/grievance/handoff', { cookie: T[who], body: { id: gid, toUsername } });

  // Alice files G-1 at L1 -- it's locked to her.
  const filed = await request(port, 'POST', '/api/grievance', { cookie: T.alice, body: { id: 'G-1', employee: 'Emp', status: 'Pending', steward: 'Alice' } });
  assert.strictEqual(filed.status, 200, 'setup: alice files G-1: ' + JSON.stringify(filed.json));
  assert.strictEqual(await lockedTo('G-1'), 'alice');

  // 1. Can't hand off to a read-only account.
  let r = await handoff('alice', 'G-1', 'viewer');
  assert.strictEqual(r.status, 400, 'a read-only account must not receive a grievance, got ' + r.status);
  assert.strictEqual(await lockedTo('G-1'), 'alice', 'the refused hand-off must leave the lock where it was');
  console.log('✓ A read-only account cannot be handed a grievance');

  // 2. Can't hand off to a steward at a different location.
  r = await handoff('alice', 'G-1', 'eve');
  assert.strictEqual(r.status, 400, "a steward at another location must not receive a grievance, got " + r.status);
  assert.strictEqual(await lockedTo('G-1'), 'alice');
  console.log("✓ A steward at another location cannot be handed a grievance");

  // 3. A steward at the same location can receive it.
  r = await handoff('alice', 'G-1', 'carl');
  assert.strictEqual(r.status, 200, 'a steward assigned to the location should be able to receive it: ' + JSON.stringify(r.json));
  assert.strictEqual(await lockedTo('G-1'), 'carl');
  console.log('✓ A steward assigned to the same location can receive it');

  // 4. Only the holder (or an admin) can pass a locked grievance on.
  r = await handoff('dana', 'G-1', 'alice');
  assert.strictEqual(r.status, 403, 'a non-holder must not hand off a locked grievance, got ' + r.status);
  assert.strictEqual(await lockedTo('G-1'), 'carl');
  console.log('✓ A non-holder cannot hand off a locked grievance');

  // 5. An unlocked (legacy) grievance can be handed off by a steward at its location.
  r = await handoff('alice', 'G-LEG', 'dana');
  assert.strictEqual(r.status, 200, 'an unlocked grievance at your location should be assignable, got: ' + JSON.stringify(r.json));
  assert.strictEqual(await lockedTo('G-LEG'), 'dana');
  console.log('✓ An unlocked grievance at your location can be handed off');

  // 6. But not an unlocked grievance at a location you do not cover.
  r = await handoff('eve', 'G-LEG', 'carl');
  assert.strictEqual(r.status, 403, 'a steward at another location must not touch this grievance, got ' + r.status);
  console.log('✓ An unlocked grievance at another location cannot be touched');

  // 7. Admin: can pass any grievance to a valid steward, but still not to a read-only account.
  r = await handoff('boss', 'G-1', 'viewer');
  assert.strictEqual(r.status, 400, 'even an admin must not hand a grievance to a read-only account');
  r = await handoff('boss', 'G-1', 'eve');
  assert.strictEqual(r.status, 400, 'an admin still cannot hand a grievance to someone without the location');
  r = await handoff('boss', 'G-1', 'alice');
  assert.strictEqual(r.status, 200, 'an admin may hand a grievance to a valid steward');
  assert.strictEqual(await lockedTo('G-1'), 'alice');
  console.log('✓ Admins can hand off freely, within the same receiver rules');

  // 8. Holders can still hand off to themselves / no-op-style and the phantom-user check still works.
  r = await handoff('alice', 'G-1', 'nobody-here');
  assert.strictEqual(r.status, 400, 'a non-existent user must still be refused');
  console.log('✓ Non-existent users are still refused');

  server.close();
  console.log('\nALL HAND-OFF RULE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
