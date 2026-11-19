const assert = require('assert');
const path = require('path');

// The daily steward reminder run used to record "done for today" even when
// every email failed (e.g. a Brevo outage), so nobody got reminded about
// deadlines that can waive a grievance. It must now keep retrying -- but only
// for the people who were missed, and not forever.

process.env.BREVO_API_KEY = 'fake';
process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';

const sends = [];            // every address a (stubbed) email was delivered to
const failFor = new Set();   // addresses the stub should fail for
const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async ({ to }) => {
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
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', locations jsonb not null default '[]', created_at timestamptz not null default now());
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

(async () => {
  const today = chicagoToday();

  // 1. Total outage: the day must NOT be marked done; a later retry succeeds.
  {
    const { scheduler, lastRun } = await freshWorld();
    failFor.add('a@x.gov'); failFor.add('b@x.gov');
    const r1 = await scheduler.runDeadlineCheck();
    assert.strictEqual(r1.sent, 0);
    assert.strictEqual(r1.retryScheduled, true, 'a total failure must schedule a retry');
    assert.notStrictEqual(await lastRun(), today, 'a day where every email failed must not be marked done');
    failFor.clear();
    const r2 = await scheduler.runDeadlineCheck();
    assert.strictEqual(r2.sent, 2, 'the retry should deliver both reminders');
    assert.strictEqual(await lastRun(), today, 'once everyone is notified the day is marked done');
    assert.strictEqual(r2.retryScheduled, false);
    console.log('✓ A total outage no longer counts as done: the retry delivers, then the day is marked done');
  }

  // 2. Partial failure: the retry emails only the person who was missed.
  {
    const { scheduler, lastRun } = await freshWorld();
    failFor.add('b@x.gov');
    await scheduler.runDeadlineCheck();
    assert.strictEqual(countTo('a@x.gov'), 1);
    assert.notStrictEqual(await lastRun(), today);
    failFor.clear();
    await scheduler.runDeadlineCheck();
    assert.strictEqual(countTo('a@x.gov'), 1, 'someone already emailed today must not be emailed again by the retry');
    assert.strictEqual(countTo('b@x.gov'), 1, 'the person who was missed gets theirs on the retry');
    assert.strictEqual(await lastRun(), today);
    console.log('✓ A partial failure retries only the missed steward; no duplicate emails');
  }

  // 3. A permanently bad address: give up after 3 attempts, and never spam the others.
  {
    const { scheduler, lastRun } = await freshWorld();
    failFor.add('b@x.gov');
    const r1 = await scheduler.runDeadlineCheck();
    const r2 = await scheduler.runDeadlineCheck();
    assert.notStrictEqual(await lastRun(), today, 'not marked done while retries remain');
    const r3 = await scheduler.runDeadlineCheck();
    assert.strictEqual(await lastRun(), today, 'after the third attempt it gives up for the day');
    assert.ok(r3.errors.some(e => /Giving up/.test(e)), 'giving up must be reported, not silent');
    assert.strictEqual(countTo('a@x.gov'), 1, 'the steward who succeeded is emailed exactly once, however many retries');
    assert.ok(r1.retryScheduled && r2.retryScheduled && !r3.retryScheduled);
    console.log('✓ A permanently failing address stops after 3 attempts; others are emailed exactly once');
  }

  // 4. Admin "Run deadline check now" still re-sends to everyone.
  {
    const { scheduler, lastRun } = await freshWorld();
    await scheduler.runDeadlineCheck();
    assert.strictEqual(await lastRun(), today);
    const m = await scheduler.runDeadlineCheck({ manual: true });
    assert.strictEqual(m.sent, 2, 'a manual run emails everyone even if they were already emailed today');
    assert.strictEqual(countTo('a@x.gov'), 2);
    console.log('✓ A manual run still emails everyone');
  }

  // 5. Manual runs never use up the automatic retry attempts.
  {
    const { db, scheduler, lastRun } = await freshWorld();
    failFor.add('a@x.gov'); failFor.add('b@x.gov');
    for (let i = 0; i < 4; i++) await scheduler.runDeadlineCheck({ manual: true });
    assert.strictEqual((await db.getEmailRunState(today)).attempts, 0, 'manual runs must not count toward the automatic attempt cap');
    assert.notStrictEqual(await lastRun(), today, 'failed manual runs must not mark the day done');
    console.log('✓ Failed manual runs neither mark the day done nor use up automatic attempts');
  }

  // 6. Nothing due: the day is marked done straight away.
  {
    const { scheduler, lastRun } = await freshWorld({ withGrievances: false });
    const r = await scheduler.runDeadlineCheck();
    assert.strictEqual(r.sent, 0);
    assert.strictEqual(await lastRun(), today);
    assert.strictEqual(r.retryScheduled, false);
    console.log('✓ With nothing to send, the day is marked done immediately');
  }

  console.log('\nALL REMINDER RETRY TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
