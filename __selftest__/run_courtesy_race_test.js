const assert = require('assert');
const path = require('path');

// A courtesy notice is meant to be sendable ONCE per step. The "already
// sent?" check and the "now it's sent" write used to be separated by the slow
// email send, so two simultaneous clicks both passed the check and both
// emailed management. It also wrote back a copy of the record read before the
// send, silently overwriting any edit saved while the email was going out.

process.env.BREVO_API_KEY = 'fake';
process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';

const sends = [];
let failAll = false;
const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async ({ to, subject }) => {
      await new Promise(r => setTimeout(r, 150)); // a real send takes time
      if (failAll) throw new Error('Brevo unavailable');
      sends.push({ to, subject });
      return { ok: true };
    }
  }
};

async function freshWorld() {
  sends.length = 0; failAll = false;
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
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table holidays (date text primary key, name text not null);
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  await db.updateOrgSettings({ managementEmail: 'mgmt@x.gov' });
  const save = (extra = {}) => db.submitGrievance({
    id: 'G-1', employee: 'Emp', steward: 'Stew', status: 'Pending', location: 'L1',
    step1filed: '2026-06-01', step2filed: '2026-06-20', actingUser: 'x', actorUsername: 'boss', ...extra
  });
  await save();
  const rec = async () => (await pool.query(`select data from grievances where id='G-1'`)).rows[0].data;
  return { db, pool, save, rec };
}

(async () => {
  // 1. Two simultaneous clicks: exactly one email goes out.
  {
    const { db, rec } = await freshWorld();
    const results = await Promise.allSettled([
      db.sendCourtesyNotice('G-1', 'step1'),
      db.sendCourtesyNotice('G-1', 'step1')
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const bad = results.filter(r => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, 'exactly one of two simultaneous requests may succeed');
    assert.strictEqual(sends.length, 1, 'management must receive exactly one email, got ' + sends.length);
    assert.ok(/already (been sent|being sent)/.test(bad[0].reason.message), 'the loser gets a clear message, got: ' + bad[0].reason.message);
    const r = await rec();
    assert.strictEqual(r.step1CourtesySent, true);
    assert.ok(!('step1CourtesyClaimedAt' in r), 'the temporary claim marker must not be left on the record');
    await assert.rejects(db.sendCourtesyNotice('G-1', 'step1'), /already been sent/);
    assert.strictEqual(sends.length, 1);
    console.log('✓ Two simultaneous clicks send exactly one email; later attempts are refused');
  }

  // 2. Step 1 and Step 2 are independent, even at the same moment.
  {
    const { db, rec } = await freshWorld();
    await Promise.all([db.sendCourtesyNotice('G-1', 'step1'), db.sendCourtesyNotice('G-1', 'step2')]);
    assert.strictEqual(sends.length, 2, 'one notice per step');
    const r = await rec();
    assert.ok(r.step1CourtesySent && r.step2CourtesySent, 'both steps recorded as sent');
    console.log('✓ Step 1 and Step 2 notices are independent');
  }

  // 3. If nothing could be sent, the steward can simply try again.
  {
    const { db, rec } = await freshWorld();
    failAll = true;
    await assert.rejects(db.sendCourtesyNotice('G-1', 'step1'), /Could not send/);
    const r = await rec();
    assert.ok(!r.step1CourtesySent, 'a failed send must not be recorded as sent');
    assert.ok(!('step1CourtesyClaimedAt' in r), 'a failed send must release its claim');
    failAll = false;
    const retry = await db.sendCourtesyNotice('G-1', 'step1');
    assert.strictEqual(retry.ok, true, 'the retry after a failure must be allowed');
    assert.strictEqual(sends.length, 1);
    console.log('✓ A failed send releases its claim, so a retry works');
  }

  // 4. A live claim blocks; a stale one (process died mid-send) does not.
  {
    const { db, pool, rec } = await freshWorld();
    const setClaim = async (iso) => {
      const r = await rec();
      await pool.query(`update grievances set data=$1::jsonb where id='G-1'`, [JSON.stringify({ ...r, step1CourtesyClaimedAt: iso })]);
    };
    await setClaim(new Date().toISOString());
    await assert.rejects(db.sendCourtesyNotice('G-1', 'step1'), /already being sent/);
    assert.strictEqual(sends.length, 0, 'a send already in progress blocks a second one');
    await setClaim(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const r = await db.sendCourtesyNotice('G-1', 'step1');
    assert.strictEqual(r.ok, true, 'a claim abandoned 10 minutes ago must not block the notice forever');
    console.log('✓ An in-progress claim blocks; an abandoned one (crash mid-send) expires');
  }

  // 5. An edit saved while the email is going out must survive.
  {
    const { db, save, rec } = await freshWorld();
    const sending = db.sendCourtesyNotice('G-1', 'step1');
    await new Promise(r => setTimeout(r, 40));            // email is now in flight
    await save({ remedy: 'Edited while the email was sending' });
    await sending;
    const r = await rec();
    assert.strictEqual(r.remedy, 'Edited while the email was sending', "the steward's edit must not be overwritten by the courtesy-notice save");
    assert.strictEqual(r.step1CourtesySent, true, 'and the notice is still recorded as sent');
    console.log('✓ An edit saved during the send is not overwritten');
  }

  console.log('\nALL COURTESY RACE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
