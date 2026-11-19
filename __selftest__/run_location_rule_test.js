const assert = require('assert');
const path = require('path');
const http = require('http');

// A grievance's location decides who can see it. Stewards are held to their
// own assigned locations: a single-location steward is always filed to that
// location, and a multi-location steward must pick one of theirs. Admins may
// pick any location.

function request(port, method, pathname, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, json, headers: res.headers }); });
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
    exports: { pool, query: (t, p) => pool.query(t, p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } } }
  };
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, locked_to text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', locations jsonb not null default '[]', created_at timestamptz not null default now());
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
  await db.upsertUser({ username: 'one', displayName: 'One', password: 'onepass123', role: 'steward', locations: ['L1'] });
  await db.upsertUser({ username: 'two', displayName: 'Two', password: 'twopass123', role: 'steward', locations: ['L1', 'L2'] });

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
    return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
  };
  const T = { boss: await login('boss', 'bosspass1'), one: await login('one', 'onepass123'), two: await login('two', 'twopass123') };
  const file = (who, id, location) => request(port, 'POST', '/api/grievance', { cookie: T[who], body: { id, employee: 'E ' + id, status: 'Pending', steward: 'S', location } });
  const storedLocation = async id => (await pool.query('select data from grievances where id=$1', [id])).rows[0].data.location;

  // A single-location steward is always filed to their own location.
  let r = await file('one', 'G-1', 'L2');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(await storedLocation('G-1'), 'L1', 'a single-location steward cannot file to another location');
  console.log('✓ A single-location steward is filed to their own location, whatever they submit');

  // A multi-location steward picks one of their own.
  r = await file('two', 'G-2', 'L2');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await storedLocation('G-2'), 'L2');
  r = await file('two', 'G-3', 'L9');
  assert.strictEqual(r.status, 400, 'a location the steward does not cover must be refused');
  console.log('✓ A multi-location steward can pick their own locations, and only those');

  // Admins may file to any location.
  r = await file('boss', 'G-4', 'L9');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await storedLocation('G-4'), 'L9');
  console.log('✓ An admin can file to any location');

  server.close();
  console.log('\nALL LOCATION RULE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
