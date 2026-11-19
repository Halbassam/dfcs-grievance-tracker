const assert = require('assert');
const path = require('path');
const http = require('http');

// Real end-to-end check of the read-only role: logs in over a real HTTP
// request against the actual server/index.js route handlers (not just the
// exported permission-check functions), so it proves the centralized
// write-guard actually blocks requests rather than just unit-testing the
// condition in isolation.

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
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cookieFromSetHeader(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const match = /dfcs_session=([^;]+)/.exec(raw || '');
  return match ? `dfcs_session=${match[1]}` : null;
}

(async () => {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();
  const poolPath = path.resolve(__dirname, '..', 'server/pool.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
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
  // First-ever account becomes admin automatically.
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({
    username: 'viewer1', displayName: 'Viewer One', password: 'viewerpass1',
    role: 'read_only', locations: ['North Suburban FCRC']
  });
  await db.submitGrievance({
    id: '2026-ro1', employee: 'Test Employee', steward: 'Someone',
    status: 'Pending', step1filed: '2026-06-01', location: 'North Suburban FCRC',
    actingUser: 'Admin One'
  });

  // Capture the real listening port -- index.js starts the server on
  // require() but doesn't expose it, so intercept http.createServer.
  const realCreateServer = http.createServer;
  let capturedServer = null;
  http.createServer = function (...args) {
    capturedServer = realCreateServer.apply(http, args);
    return capturedServer;
  };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;

  await new Promise(resolve => {
    if (capturedServer.listening) return resolve();
    capturedServer.once('listening', resolve);
  });
  const port = capturedServer.address().port;

  try {
    // Log in as the read-only user.
    const loginRes = await request(port, 'POST', '/api/auth/login', {
      body: { username: 'viewer1', password: 'viewerpass1' }
    });
    assert.strictEqual(loginRes.status, 200, 'read-only login should succeed, got: ' + JSON.stringify(loginRes.json));
    const cookie = cookieFromSetHeader(loginRes.headers['set-cookie']);
    assert.ok(cookie, 'expected a session cookie from login');
    console.log('✓ Read-only account can log in');

    // Can view data.
    const dataRes = await request(port, 'GET', '/api/data', { cookie });
    assert.strictEqual(dataRes.status, 200, 'GET /api/data should succeed for a read-only account');
    assert.ok(dataRes.json.grievances.some(g => g.id === '2026-ro1'), 'read-only account should see the grievance at its own location');
    console.log('✓ Read-only account can view scoped grievance data');

    // Cannot create/edit a grievance.
    const submitRes = await request(port, 'POST', '/api/grievance', {
      cookie, body: { id: '2026-ro2', employee: 'Blocked', status: 'Pending', location: 'North Suburban FCRC' }
    });
    assert.strictEqual(submitRes.status, 403, 'POST /api/grievance must be blocked for a read-only account, got: ' + submitRes.status);
    assert.ok(/read-only/i.test(submitRes.json.error || ''), 'error should mention the account is read-only, got: ' + JSON.stringify(submitRes.json));
    console.log('✓ Read-only account is blocked from creating/editing a grievance (403)');

    // Cannot log activity.
    const activityRes = await request(port, 'POST', '/api/activity', {
      cookie, body: { gid: '2026-ro1', text: 'Should be blocked' }
    });
    assert.strictEqual(activityRes.status, 403, 'POST /api/activity must be blocked for a read-only account');
    console.log('✓ Read-only account is blocked from logging activity (403)');

    // Cannot archive.
    const archiveRes = await request(port, 'POST', '/api/archive', { cookie, body: {} });
    assert.strictEqual(archiveRes.status, 403, 'POST /api/archive must be blocked for a read-only account');
    console.log('✓ Read-only account is blocked from archiving (403)');

    // CAN change their own password (self-service, not grievance data).
    const changePwRes = await request(port, 'POST', '/api/auth/change-password', {
      cookie, body: { currentPassword: 'viewerpass1', newPassword: 'newviewerpass2' }
    });
    assert.strictEqual(changePwRes.status, 200, 'a read-only account must still be able to change its own password, got: ' + JSON.stringify(changePwRes.json));
    console.log('✓ Read-only account can still change its own password');

    // Logout must not throw (regression check for the currentUser TDZ fix).
    const logoutRes = await request(port, 'POST', '/api/auth/logout', { cookie });
    assert.strictEqual(logoutRes.status, 200, 'logout should succeed, got: ' + JSON.stringify(logoutRes.json));
    console.log('✓ Logout succeeds without throwing (currentUser-before-initialization regression check)');

    console.log('\nALL READ-ONLY ROLE TESTS PASSED');
    process.exit(0);
  } finally {
    capturedServer.close();
  }
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
