const assert = require('assert');
const path = require('path');
const http = require('http');

// Converting an investigation used to mark it "converted" immediately, before
// any grievance existed. Cancelling the intake form then left it stuck (it
// could never be converted again), and closing it afterwards overwrote the
// "converted" status. Conversion should only complete once the grievance is
// actually saved.

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
    create table investigations (id text primary key, data jsonb not null, created_at timestamptz not null default now());
    create table investigation_tokens (token text primary key, investigation_id text not null, type text not null, witness_name text, created_at timestamptz not null default now(), expires_at timestamptz not null, submitted_at timestamptz);
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  await db.upsertUser({ username: 'boss', displayName: 'Boss', password: 'bosspass1' });
  await db.upsertUser({ username: 'alice', displayName: 'Alice', password: 'alicepass1', role: 'steward', locations: ['L1'] });

  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const loginRes = await request(port, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'alicepass1' } });
  const cookie = /dfcs_session=([^;]+)/.exec(loginRes.headers['set-cookie'][0])[0];
  const convert = (id, grievanceId) => request(port, 'POST', '/api/investigation/convert', { cookie, body: { id, grievanceId } });
  const save = (gid, extra = {}) => request(port, 'POST', '/api/grievance', { cookie, body: { id: gid, employee: 'Emp', status: 'Pending', steward: 'Alice', ...extra } });
  const invStatus = async id => (await db.getInvestigation(id));
  const newInv = () => db.createInvestigation({ location: 'L1', steward: 'Alice', employee: 'Emp', contactEmail: '', actingUser: 'boss' });

  // 1. Convert, then save the grievance: the investigation becomes converted and links to it.
  {
    const inv = await newInv();
    const c = await convert(inv.id, 'G-1');
    assert.strictEqual(c.status, 200, JSON.stringify(c.json));
    assert.strictEqual(c.json.preFilledGrievance.investigationId, inv.id);
    assert.strictEqual((await invStatus(inv.id)).status, 'open', 'converting alone must not mark the investigation converted');
    const s = await save('G-1', { investigationId: inv.id });
    assert.strictEqual(s.status, 200, JSON.stringify(s.json));
    const after = await invStatus(inv.id);
    assert.strictEqual(after.status, 'converted');
    assert.strictEqual(after.convertedGrievanceId, 'G-1');
    console.log('✓ Converting and then saving the grievance marks the investigation converted and links it');
  }

  // 2. A cancelled conversion leaves the investigation open, logbook-able and convertible again.
  {
    const inv = await newInv();
    await convert(inv.id, 'G-2-CANCELLED');
    // (the intake form is never saved)
    assert.strictEqual((await invStatus(inv.id)).status, 'open');
    await db.addInvestigationLogEntry(inv.id, { date: '2026-01-02', steward: 'Alice', entry: 'still working this' });
    const again = await convert(inv.id, 'G-2');
    assert.strictEqual(again.status, 200, 'a cancelled conversion must be retryable: ' + JSON.stringify(again.json));
    await save('G-2', { investigationId: inv.id });
    assert.strictEqual((await invStatus(inv.id)).convertedGrievanceId, 'G-2');
    console.log('✓ A cancelled conversion leaves the investigation open and convertible again');
  }

  // 3. Once converted, it cannot be closed, and the link is kept.
  {
    const inv = await newInv();
    await convert(inv.id, 'G-3');
    await save('G-3', { investigationId: inv.id });
    const close = await request(port, 'POST', '/api/investigation/close', { cookie, body: { id: inv.id, reason: 'resolved', notes: '' } });
    assert.strictEqual(close.status, 400, 'closing a converted investigation must be refused');
    assert.ok(/became grievance G-3/.test(close.json.error), 'the refusal should name the grievance: ' + close.json.error);
    const after = await invStatus(inv.id);
    assert.strictEqual(after.status, 'converted', 'the converted status must survive a close attempt');
    assert.strictEqual(after.convertedGrievanceId, 'G-3');
    console.log('✓ A converted investigation cannot be closed, and its link is preserved');
  }

  // 4. Closing an open investigation, mid-conversion, cancels the pending conversion.
  {
    const inv = await newInv();
    await convert(inv.id, 'G-4');
    await db.closeInvestigation(inv.id, { reason: 'no_violation', notes: '' });
    await save('G-4', { investigationId: inv.id });
    const after = await invStatus(inv.id);
    assert.strictEqual(after.status, 'closed', 'a closed investigation must not become converted by a late save');
    console.log('✓ Closing mid-conversion cancels the pending link');
  }

  // 5. A save that doesn't match the pending number does not convert it.
  {
    const inv = await newInv();
    await convert(inv.id, 'G-5');
    await save('G-OTHER', { investigationId: inv.id });
    assert.strictEqual((await invStatus(inv.id)).status, 'open', 'saving a different grievance must not convert this investigation');
    console.log('✓ A save of a different grievance does not convert the investigation');
  }

  // 6. A grievance number already in use is refused up front.
  {
    const inv = await newInv();
    await save('G-6');
    const c = await convert(inv.id, 'G-6');
    assert.strictEqual(c.status, 400, 'converting onto an existing grievance number must be refused');
    assert.ok(/already in use/.test(c.json.error), c.json.error);
    assert.strictEqual((await invStatus(inv.id)).status, 'open');
    console.log('✓ Converting onto a grievance number already in use is refused');
  }

  // 7. Converting twice is refused once it has really been converted.
  {
    const inv = await newInv();
    await convert(inv.id, 'G-7');
    await save('G-7', { investigationId: inv.id });
    const again = await convert(inv.id, 'G-7b');
    assert.strictEqual(again.status, 400);
    assert.ok(/Already converted/.test(again.json.error));
    console.log('✓ An investigation that has been converted cannot be converted again');
  }

  // 8. Ordinary closing still works.
  {
    const inv = await newInv();
    const c = await request(port, 'POST', '/api/investigation/close', { cookie, body: { id: inv.id, reason: 'withdrew', notes: 'ok' } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.json));
    assert.strictEqual((await invStatus(inv.id)).status, 'closed');
    console.log('✓ Closing an ordinary open investigation still works');
  }

  server.close();
  console.log('\nALL INVESTIGATION CONVERT TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
