const assert = require('assert');
const path = require('path');
const http = require('http');

// On a host that sleeps when idle, an in-process hourly timer may never get to
// fire. Today's reminder check must therefore also run at startup and when the
// keep-alive ping hits /api/health -- without ever running twice at once or
// more often than needed.

process.env.BREVO_API_KEY = 'fake';
process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';

const sends = [];            // every address a (stubbed) email was delivered to
const failFor = new Set();   // addresses the stub should fail for
const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async ({ to }) => {
      await new Promise(r => setTimeout(r, 60)); // a real send takes time
      if (failFor.has(to)) throw new Error('Brevo unavailable for ' + to);
      sends.push(to);
      return { ok: true };
    }
  }
};

function chicagoToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}`;
}
function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const countTo = addr => sends.filter(a => a === addr).length;

async function freshWorld({ withGrievances = true } = {}) {
  sends.length = 0; failFor.clear();
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
  delete require.cache[path.resolve(__dirname, '..', 'server/scheduler.js')];
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, locked_to text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table holidays (date text primary key, name text not null);
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', locations jsonb not null default '[]', email text not null default '', is_steward boolean not null default false, created_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table setup_lists (key text primary key, items jsonb not null default '[]');
    create table attachments (id text primary key, gid text not null, filename text not null, content_type text not null, size_bytes integer not null, storage_path text not null, uploaded_by text not null, uploaded_at timestamptz not null default now());
  `);
  if (withGrievances) {
    // Two stewards, each with a Step 1 response that's long overdue.
    for (const [id, name, email] of [['G-A', 'Alice', 'a@x.gov'], ['G-B', 'Bob', 'b@x.gov']]) {
      await pool.query(
        `insert into grievances (id, status, steward, data) values ($1,'Pending',$2,$3::jsonb)`,
        [id, name, JSON.stringify({ id, employee: 'Emp ' + id, steward: name, stewardEmail: email, status: 'Pending', step1filed: isoDaysAgo(30) })]
      );
    }
  }
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const scheduler = require(path.resolve(__dirname, '..', 'server/scheduler.js'));
  const lastRun = async () => (await db.getAll()).lastEmailRunDate;
  return { db, scheduler, lastRun };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(25); }
  return false;
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    }).on('error', reject);
  });
}

(async () => {
  const today = chicagoToday();

  // 1. Sends when today is unfinished; does nothing once it is finished.
  {
    const { scheduler, lastRun } = await freshWorld();
    const r = await scheduler.runDailyCheckIfDue();
    assert.ok(r && r.sent === 2, 'first call should send both reminders');
    assert.strictEqual(await lastRun(), today);
    const again = await scheduler.runDailyCheckIfDue({ force: true });
    assert.strictEqual(again, null, 'once today is finished, further calls must do nothing');
    assert.strictEqual(sends.length, 2, 'and must not email anyone again');
    console.log('✓ Runs when today is unfinished, and does nothing once it is finished');
  }

  // 2. Overlapping calls (health ping + timer at the same moment) collapse into one run.
  {
    const { scheduler } = await freshWorld();
    const [a, b, c] = await Promise.all([
      scheduler.runDailyCheckIfDue({ force: true }),
      scheduler.runDailyCheckIfDue({ force: true }),
      scheduler.runDailyCheckIfDue()
    ]);
    assert.strictEqual([a, b, c].filter(Boolean).length, 1, 'only one of three simultaneous calls should actually run');
    assert.strictEqual(sends.length, 2, 'each steward is emailed once, not once per caller');
    console.log('✓ Simultaneous triggers collapse into a single run (no duplicate emails)');
  }

  // 3. Triggers from outside (the public health URL) are throttled; the scheduler's own timer is not.
  {
    const { db, scheduler } = await freshWorld();
    failFor.add('a@x.gov'); failFor.add('b@x.gov');
    await scheduler.runDailyCheckIfDue();
    assert.strictEqual((await db.getEmailRunState(today)).attempts, 1);
    const throttled = await scheduler.runDailyCheckIfDue();
    assert.strictEqual(throttled, null, 'an immediate second outside trigger must be throttled');
    assert.strictEqual((await db.getEmailRunState(today)).attempts, 1, 'a throttled call must not use up an attempt');
    await scheduler.runDailyCheckIfDue({ force: true });
    assert.strictEqual((await db.getEmailRunState(today)).attempts, 2, 'the timer/startup path (force) is not throttled');
    console.log('✓ Repeated outside triggers are throttled; the scheduler\'s own check is not');
  }

  // 4. startScheduler() checks shortly after startup instead of waiting an hour.
  {
    const { scheduler, lastRun } = await freshWorld();
    scheduler.startScheduler({ startupDelayMs: 40 });
    const ok = await waitFor(async () => (await lastRun()) === today);
    assert.ok(ok, 'the startup check should send today\'s reminders without waiting for the hourly timer');
    assert.strictEqual(sends.length, 2);
    console.log('✓ Reminders go out shortly after startup (no one-hour wait)');
  }

  // 5. The keep-alive ping to /api/health also makes sure today's reminders went out.
  {
    const { scheduler, lastRun } = await freshWorld();
    const realCreateServer = http.createServer;
    let server;
    http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
    process.env.PORT = '0';
    delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
    require(path.resolve(__dirname, '..', 'server/index.js'));
    http.createServer = realCreateServer;
    await new Promise(r => server.listening ? r() : server.once('listening', r));
    const port = server.address().port;

    const health = await get(port, '/api/health');
    assert.strictEqual(health.status, 200, 'the health endpoint must still answer normally');
    const ok = await waitFor(async () => (await lastRun()) === today);
    assert.ok(ok, 'a health ping should trigger today\'s reminder check');
    assert.strictEqual(sends.length, 2);

    await get(port, '/api/health'); await get(port, '/api/health');
    await sleep(300);
    assert.strictEqual(sends.length, 2, 'more pings after the day is done must not send anything');
    server.close();
    console.log('✓ The keep-alive ping triggers the check, and repeat pings are harmless');
  }

  console.log('\nALL SCHEDULER WAKE-UP TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
