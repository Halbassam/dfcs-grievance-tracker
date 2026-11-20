const assert = require('assert');
const path = require('path');
const http = require('http');

// The admin Email log shows up to 200 entries, newest first, and only to admins.

function request(port, method, pathname, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  const { newDb } = require('pg-mem');
  const pool = new (newDb().adapters.createPg().Pool)();
  const poolPath = path.resolve(__dirname, '..', 'server/pool.js');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
    pool, query: (t, p) => pool.query(t, p),
    withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } } } };
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
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({ username: 'steward1', displayName: 'Steward One', password: 'stewardpass1', role: 'steward' });

  // 250 entries, written in order; the newest must come back first.
  for (let i = 1; i <= 250; i++) {
    await db.logEmailAttempt({ kind: 'grievant-update', gid: 'G-' + i, step: 'step1', to: 'a' + i + '@x.gov', ok: true });
  }
  const log = await db.getEmailLog(200);
  assert.strictEqual(log.length, 200, 'the log keeps up to 200 entries');
  assert.strictEqual(log[0].gid, 'G-250', 'the newest entry comes first');
  assert.strictEqual(log[199].gid, 'G-51', 'the 200th entry is the 200th newest');
  console.log('✓ The log returns the newest 200 entries, newest first');

  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  try {
    const login = async (u, p) => {
      const r = await request(port, 'POST', '/api/auth/login', { body: { username: u, password: p } });
      return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
    };
    const admin = await login('admin1', 'adminpass1');
    const steward = await login('steward1', 'stewardpass1');

    const forAdmin = await request(port, 'GET', '/api/email/status', { cookie: admin });
    assert.strictEqual(forAdmin.status, 200);
    assert.strictEqual(forAdmin.json.emailLog.length, 200, 'admin sees up to 200 entries');
    assert.strictEqual(forAdmin.json.emailLog[0].gid, 'G-250');
    const forSteward = await request(port, 'GET', '/api/email/status', { cookie: steward });
    assert.deepStrictEqual(forSteward.json.emailLog, [], 'non-admins do not see the email log');
    console.log('✓ Admins see up to 200 entries over HTTP; other users see none');
  } finally {
    server.close();
  }
  console.log('\nALL EMAIL LOG VIEW TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
