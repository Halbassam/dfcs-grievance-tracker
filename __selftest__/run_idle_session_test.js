const assert = require('assert');
const path = require('path');
const http = require('http');

// Sessions end after 30 minutes with no user activity. Only the activity
// ping extends them; background polling must not. Checked over real HTTP
// against server/index.js with pg-mem as the database.

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
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({ username: 'viewer1', displayName: 'Viewer One', password: 'viewerpass1', role: 'read_only' });

  // Direct checks on the session store.
  const token = await db.createSession('admin1');
  const expiresAt = async t => (await pool.query('select expires_at from sessions where token=$1', [t])).rows[0].expires_at.getTime();
  const minsFromNow = ms => (ms - Date.now()) / 60000;
  assert.ok(Math.abs(minsFromNow(await expiresAt(token)) - 30) < 1, 'a new session expires 30 minutes after login');
  console.log('✓ A new session expires 30 minutes after login, not 30 days');

  await pool.query("update sessions set expires_at = now() - interval '1 minute' where token=$1", [token]);
  assert.strictEqual(await db.getSessionUser(token), null, 'a session idle past its deadline is rejected');
  console.log('✓ A session idle past its deadline is rejected');

  // An active session gets its deadline moved forward; an expired one is not revived.
  await pool.query("update sessions set expires_at = now() + interval '5 minutes' where token=$1", [token]);
  await db.touchSession(token);
  assert.ok(Math.abs(minsFromNow(await expiresAt(token)) - 30) < 1, 'an activity ping moves the deadline to 30 minutes from now');
  await pool.query("update sessions set expires_at = now() - interval '1 minute' where token=$1", [token]);
  await db.touchSession(token);
  assert.ok(await expiresAt(token) < Date.now(), 'an expired session is not revived by an activity ping');
  console.log('✓ An activity ping extends an active session, and does not revive an expired one');

  // Over HTTP.
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
    const cookie = await login('viewer1', 'viewerpass1');
    const sessionTok = cookie.split('=')[1];

    // Polling (a background refresh) must not extend the session.
    await pool.query("update sessions set expires_at = now() + interval '5 minutes' where token=$1", [sessionTok]);
    const poll = await request(port, 'GET', '/api/data', { cookie });
    assert.strictEqual(poll.status, 200);
    assert.ok(minsFromNow(await expiresAt(sessionTok)) < 6, 'a background poll must not extend the idle deadline');
    console.log('✓ Background polling does not extend the idle deadline');

    // A real activity ping extends it, including for a read-only account.
    const ping = await request(port, 'POST', '/api/auth/activity', { cookie });
    assert.strictEqual(ping.status, 200, 'a read-only account must be able to send the activity ping, got ' + ping.status);
    assert.ok(Math.abs(minsFromNow(await expiresAt(sessionTok)) - 30) < 1, 'the activity ping extends the session');
    console.log('✓ A read-only account can send the activity ping, which extends the session');

    // Once idle past the deadline, every request is refused.
    await pool.query("update sessions set expires_at = now() - interval '1 minute' where token=$1", [sessionTok]);
    assert.strictEqual((await request(port, 'GET', '/api/data', { cookie })).status, 401, 'an idle session must be refused');
    assert.strictEqual((await request(port, 'POST', '/api/auth/activity', { cookie })).status, 401, 'an idle session cannot be revived by the ping');
    console.log('✓ After 30 idle minutes, requests are refused with 401');
  } finally {
    server.close();
  }

  console.log('\nALL IDLE SESSION TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
