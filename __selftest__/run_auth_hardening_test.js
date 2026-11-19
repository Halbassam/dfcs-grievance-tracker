const assert = require('assert');
const path = require('path');
const http = require('http');

// Sign-in and session hardening, checked over real HTTP:
// - changing a password signs out every other session for that account;
// - failed sign-ins are counted per username AND client address, so one
//   stranger can't lock the real user out from elsewhere;
// - the client address comes from the end of X-Forwarded-For (the part the
//   proxy adds), not the start, which the client controls.

function request(port, method, pathname, { body, cookie, xff } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(xff ? { 'X-Forwarded-For': xff } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers });
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
  await db.upsertUser({ username: 'steve', displayName: 'Steve', password: 'stevepass1', role: 'steward', locations: ['L1'] });
  await db.upsertUser({ username: 'lockme', displayName: 'Lock Me', password: 'lockpass12', role: 'steward', locations: ['L1'] });

  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const login = async (username, password, xff = '10.0.0.1') => {
    const r = await request(port, 'POST', '/api/auth/login', { body: { username, password }, xff });
    if (r.status !== 200) return null;
    return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
  };
  const sessionStatus = async cookie => (await request(port, 'GET', '/api/auth/session', { cookie })).status;

  // 1. Changing a password signs out the account's other sessions, but not the one making the change.
  {
    const phoneSession = await login('steve', 'stevepass1', '10.1.0.1');
    const laptopSession = await login('steve', 'stevepass1', '10.1.0.2');
    const change = await request(port, 'POST', '/api/auth/change-password', {
      cookie: laptopSession, body: { currentPassword: 'stevepass1', newPassword: 'brandnew99' }
    });
    assert.strictEqual(change.status, 200, JSON.stringify(change.json));
    assert.strictEqual(await sessionStatus(phoneSession), 401, 'the other session must be signed out by the password change');
    assert.strictEqual(await sessionStatus(laptopSession), 200, 'the session that changed the password stays signed in');
    console.log('✓ Changing a password signs out the account\'s other sessions');
  }

  // 2. Failures are counted per address: the real user is not locked out from elsewhere.
  {
    for (let i = 0; i < 10; i++) {
      const r = await request(port, 'POST', '/api/auth/login', { body: { username: 'lockme', password: 'wrong' + i }, xff: '203.0.113.9' });
      assert.strictEqual(r.status, 401);
    }
    const attacker = await request(port, 'POST', '/api/auth/login', { body: { username: 'lockme', password: 'lockpass12' }, xff: '203.0.113.9' });
    assert.strictEqual(attacker.status, 429, 'the address that failed ten times is locked out');
    const realUser = await request(port, 'POST', '/api/auth/login', { body: { username: 'lockme', password: 'lockpass12' }, xff: '198.51.100.7' });
    assert.strictEqual(realUser.status, 200, 'the real user signing in from another address must not be locked out, got ' + realUser.status);
    console.log('✓ One address failing repeatedly does not lock the real user out elsewhere');
  }

  // 3. The client address is the proxy-added (last) entry, so a forged first entry buys nothing.
  {
    for (let i = 0; i < 10; i++) {
      await request(port, 'POST', '/api/auth/login', { body: { username: 'boss', password: 'nope' + i }, xff: '192.0.2.50' });
    }
    const forged = await request(port, 'POST', '/api/auth/login', { body: { username: 'boss', password: 'bosspass1' }, xff: '1.2.3.4, 192.0.2.50' });
    assert.strictEqual(forged.status, 429, 'a forged leading address must not get around the lockout');
    console.log('✓ A forged leading X-Forwarded-For address does not avoid the lockout');
  }

  // 4. A sign-in with no password, or for an unknown user, is refused cleanly.
  {
    const noPw = await request(port, 'POST', '/api/auth/login', { body: { username: 'steve' }, xff: '10.9.0.1' });
    assert.strictEqual(noPw.status, 401, 'a missing password must be refused, not crash the server');
    const unknown = await request(port, 'POST', '/api/auth/login', { body: { username: 'nobody-here', password: 'x' }, xff: '10.9.0.2' });
    assert.strictEqual(unknown.status, 401);
    assert.strictEqual(unknown.json.error, 'Incorrect username or password.', 'unknown users get the same message as wrong passwords');
    console.log('✓ Missing passwords and unknown usernames are refused with the same message');
  }

  server.close();
  console.log('\nALL AUTH HARDENING TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
