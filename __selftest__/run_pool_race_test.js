const assert = require('assert');
const path = require('path');
const http = require('http');

// Grievance numbers are handed out from a shared pool stored as JSON in
// app_meta. withLock() used to be a no-op, so concurrent requests read the
// same pool: two stewards clicking "Assign next" together got the SAME number
// and writes overwrote each other. Also, any user could "return" a number
// another steward was holding, making it available to hand out again.

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

async function freshDb() {
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
  delete require.cache[path.resolve(__dirname, '..', 'server/db.js')];
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
  return require(path.resolve(__dirname, '..', 'server/db.js'));
}

(async () => {
  // 1. Many simultaneous "Assign next" clicks must each get a different number.
  {
    const db = await freshDb();
    const numbers = Array.from({ length: 20 }, (_, i) => `N-${String(i + 1).padStart(3, '0')}`);
    await db.addToGrievanceNumberPool(numbers, 'boss');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => db.consumeNextGrievanceNumber('steward' + i))
    );
    const handedOut = results.map(r => r.number);
    assert.strictEqual(new Set(handedOut).size, 10, 'every steward must get a different number, got: ' + handedOut.join(','));
    const { pool, log } = await db.getGrievanceNumberPool();
    assert.strictEqual(pool.length, 10, 'exactly 10 numbers should be left in the pool, got ' + pool.length);
    assert.strictEqual(log.length, 10, 'every assignment must be logged (none lost to overwrites), got ' + log.length);
    console.log('✓ 10 simultaneous "Assign next" clicks get 10 different numbers, all logged');
  }

  // 2. Simultaneous adds must not overwrite each other.
  {
    const db = await freshDb();
    await Promise.all([
      db.addToGrievanceNumberPool(['A-1', 'A-2', 'A-3'], 'x'),
      db.addToGrievanceNumberPool(['B-1', 'B-2', 'B-3'], 'y')
    ]);
    const { pool } = await db.getGrievanceNumberPool();
    assert.deepStrictEqual([...pool].sort(), ['A-1', 'A-2', 'A-3', 'B-1', 'B-2', 'B-3'], 'both batches must survive, got: ' + pool.join(','));
    console.log('✓ Two simultaneous batches added to the pool both survive');
  }

  // 3. A failing operation must not block the ones queued behind it.
  {
    const db = await freshDb();
    const failing = db.withLock(async () => { throw new Error('boom'); });
    const after = db.withLock(async () => 'still works');
    await assert.rejects(failing, /boom/);
    assert.strictEqual(await after, 'still works', 'an error in one locked section must not wedge later ones');
    console.log('✓ A failing locked operation does not block later ones');
  }

  // 4. Only the current holder (or an admin) may return a number.
  {
    const db = await freshDb();
    await db.addToGrievanceNumberPool(['P-1', 'P-2'], 'boss');
    const a = await db.consumeNextGrievanceNumber('alice');
    assert.strictEqual(a.number, 'P-1');

    const stranger = await db.returnGrievanceNumber('P-1', { username: 'bob' });
    assert.deepStrictEqual([stranger.ok, stranger.reason], [false, 'not_yours'], "another steward must not be able to return alice's number");
    assert.ok(!(await db.getGrievanceNumberPool()).pool.includes('P-1'), "P-1 must not be back in the pool: alice is still using it");

    const own = await db.returnGrievanceNumber('P-1', { username: 'alice' });
    assert.strictEqual(own.ok, true, 'the holder can return their own number');
    assert.strictEqual((await db.getGrievanceNumberPool()).pool[0], 'P-1', 'a returned number goes back to the front');

    // Once bob has it, alice returning it again (e.g. a stale tab) must not pull it from him.
    const b = await db.consumeNextGrievanceNumber('bob');
    assert.strictEqual(b.number, 'P-1');
    const stale = await db.returnGrievanceNumber('P-1', { username: 'alice' });
    assert.strictEqual(stale.reason, 'not_yours', "alice's stale return must not take back a number bob now holds");

    const byAdmin = await db.returnGrievanceNumber('P-1', { username: 'boss', isAdmin: true });
    assert.strictEqual(byAdmin.ok, true, 'an admin may return any number');
    assert.strictEqual((await db.returnGrievanceNumber('never-assigned', { username: 'alice' })).ok, false, 'a number nobody was assigned cannot be "returned"');
    console.log('✓ Only the current holder (or an admin) can return a number');
  }

  // 5. The same rule over real HTTP.
  {
    const db = await freshDb();
    await db.upsertUser({ username: 'boss', displayName: 'Boss', password: 'bosspass1' });
    await db.upsertUser({ username: 'alice', displayName: 'Alice', password: 'alicepass1', role: 'steward', locations: ['L1'] });
    await db.upsertUser({ username: 'bob', displayName: 'Bob', password: 'bobpass123', role: 'steward', locations: ['L1'] });
    await db.addToGrievanceNumberPool(['H-1', 'H-2'], 'boss');

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
    const alice = await login('alice', 'alicepass1');
    const bob = await login('bob', 'bobpass123');

    const got = await request(port, 'POST', '/api/grievance-pool/consume', { cookie: alice });
    assert.strictEqual(got.json.number, 'H-1');
    const bobTries = await request(port, 'POST', '/api/grievance-pool/return', { cookie: bob, body: { number: 'H-1' } });
    assert.strictEqual(bobTries.json.ok, false);
    assert.strictEqual(bobTries.json.reason, 'not_yours');
    const aliceReturns = await request(port, 'POST', '/api/grievance-pool/return', { cookie: alice, body: { number: 'H-1' } });
    assert.strictEqual(aliceReturns.json.ok, true);
    server.close();
    console.log("✓ Over HTTP: bob can't return alice's number; alice can");
  }

  console.log('\nALL POOL RACE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
