const assert = require('assert');
const path = require('path');
const http = require('http');

// A date that was entered by mistake could never be removed. The save code
// only copied non-blank dates, so clearing the field kept the old value. A
// mistaken Step 3 date then switched off every reminder for that case
// permanently. A blank date must now clear the stored one, while a save that
// doesn't mention a date at all keeps it.

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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
  const stored = async gid => (await pool.query('select data from grievances where id=$1', [gid])).rows[0].data;

  // 1. A cleared date is cleared (the bug).
  await db.submitGrievance({ id: 'G-1', employee: 'E', steward: 'S', status: 'Pending', location: 'L1',
    step1filed: '2026-06-01', step3filed: '2026-07-01', actingUser: 'x', actorUsername: 'boss' });
  await db.submitGrievance({ id: 'G-1', employee: 'E', steward: 'S', status: 'Pending', location: 'L1',
    step1filed: '2026-06-01', step3filed: '', actingUser: 'x', actorUsername: 'boss' });
  assert.ok(!(await stored('G-1')).step3filed, "a Step 3 date the steward cleared must be removed, got: " + (await stored('G-1')).step3filed);
  assert.strictEqual((await stored('G-1')).step1filed, '2026-06-01', 'other dates in the same save are unaffected');
  console.log('✓ A date the steward clears is actually cleared');

  // 2. A save that doesn't mention a date keeps it (the existing behaviour).
  await db.submitGrievance({ id: 'G-2', employee: 'E', steward: 'S', status: 'Pending', location: 'L1',
    step1filed: '2026-06-01', step2filed: '2026-06-20', actingUser: 'x', actorUsername: 'boss' });
  await db.submitGrievance({ id: 'G-2', employee: 'E', steward: 'S', status: 'Pending', location: 'L1',
    step2resp: '2026-07-01', actingUser: 'x', actorUsername: 'boss' });
  const g2 = await stored('G-2');
  assert.strictEqual(g2.step1filed, '2026-06-01', 'a date absent from the save must be kept');
  assert.strictEqual(g2.step2filed, '2026-06-20', 'a date absent from the save must be kept');
  console.log('✓ A save that does not mention a date keeps it');

  // 3. Clearing a date brings back the reminder that a wrong date had hidden.
  await db.submitGrievance({ id: 'G-3', employee: 'E', steward: 'S', stewardEmail: 's@x.gov', status: 'Pending', location: 'L1',
    step1filed: isoDaysAgo(30), step3filed: isoDaysAgo(5), actingUser: 'x', actorUsername: 'boss' });
  let upcoming = await db.findUpcomingDeadlines(3);
  assert.ok(!upcoming.some(u => u.id === 'G-3'), 'with a Step 3 date set, no deadline reminder is generated');
  await db.submitGrievance({ id: 'G-3', employee: 'E', steward: 'S', stewardEmail: 's@x.gov', status: 'Pending', location: 'L1',
    step1filed: isoDaysAgo(30), step3filed: '', actingUser: 'x', actorUsername: 'boss' });
  upcoming = await db.findUpcomingDeadlines(3);
  assert.ok(upcoming.some(u => u.id === 'G-3' && u.daysAway < 0), 'once the wrong Step 3 date is cleared, the overdue Step 1 reminder comes back');
  console.log('✓ Clearing a mistaken Step 3 date brings the overdue reminder back');

  // 4. Over HTTP, as the intake form sends it: all date fields, blanks included.
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
  const token = await (async () => {
    const r = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: 'alice', password: 'alicepass1' });
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0]));
      });
      req.on('error', reject); req.write(data); req.end();
    });
    return /dfcs_session=([^;]+)/.exec(r)[0];
  })();
  const saved = await request(port, 'POST', '/api/grievance', { cookie: token, body: {
    id: 'G-4', employee: 'Emp', status: 'Pending', steward: 'Alice',
    awareness: '2026-05-01', step1filed: '2026-06-01', step1resp: '', step2filed: '', step2resp: '',
    step3filed: '2026-07-01', step3resp: '', step4filed: ''
  } });
  assert.strictEqual(saved.status, 200, 'setup save: ' + JSON.stringify(saved.json));
  const cleared = await request(port, 'POST', '/api/grievance', { cookie: token, body: {
    id: 'G-4', employee: 'Emp', status: 'Pending', steward: 'Alice',
    awareness: '2026-05-01', step1filed: '2026-06-01', step1resp: '', step2filed: '', step2resp: '',
    step3filed: '', step3resp: '', step4filed: ''
  } });
  assert.strictEqual(cleared.status, 200);
  assert.ok(!(await stored('G-4')).step3filed, 'clearing Step 3 in the intake form must clear it on the server');
  server.close();
  console.log('✓ Clearing a date in the intake form clears it on the server');

  console.log('\nALL CLEARABLE DATE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
