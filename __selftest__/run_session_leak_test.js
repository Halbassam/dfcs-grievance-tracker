const assert = require('assert');
const path = require('path');
const http = require('http');

// Regression test: GET /api/data goes to every logged-in user, so it must
// never contain session tokens (a token is a working login) or password
// hashes. Previously a plain steward could read the admin's token from it
// and become admin.

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
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pool = new (mem.adapters.createPg().Pool)();
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
  await db.upsertUser({ username: 'steve', displayName: 'Steve', password: 'stevepass1', role: 'steward', locations: ['L1'] });

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
    assert.strictEqual(r.status, 200, `login for ${u} failed`);
    return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[1];
  };
  const adminToken = await login('boss', 'bosspass1');
  const steveToken = await login('steve', 'stevepass1');

  for (const [who, token] of [['steward', steveToken], ['admin', adminToken]]) {
    const res = await request(port, 'GET', '/api/data', { cookie: 'dfcs_session=' + token });
    assert.strictEqual(res.status, 200);
    assert.ok(!('sessions' in res.json), `/api/data must not include a "sessions" field for a ${who}`);
    for (const t of [adminToken, steveToken]) {
      assert.ok(!res.raw.includes(t), `/api/data response for a ${who} must not contain any session token`);
    }
    assert.ok(!/scrypt:/.test(res.raw), `/api/data response for a ${who} must not contain a password hash`);
  }
  console.log('✓ /api/data contains no session tokens or password hashes, for stewards or admins');

  console.log('\nALL SESSION LEAK TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
