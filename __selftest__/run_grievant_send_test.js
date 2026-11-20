const assert = require('assert');
const path = require('path');

// Every filed step (1, 2 and 3) emails each grievant address, once. Checked with
// the mail service stubbed, using pg-mem as the database.

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

  // Stub the mail service. `plan` decides what each call does, by recipient.
  const sent = [];
  let plan = () => 'ok';
  const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
  require.cache[mailerPath] = {
    id: mailerPath, filename: mailerPath, loaded: true,
    exports: {
      sendMail: async (args) => {
        const outcome = plan(args.to, sent.length);
        sent.push({ to: args.to, subject: args.subject, outcome });
        if (outcome === 'ok') return { ok: true };
        throw new Error(outcome);
      }
    }
  };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'noreply@example.gov';

  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const gn = require(path.resolve(__dirname, '..', 'server/grievantNotify.js'));
  gn._setRetryDelaysForTest([0, 0]);
  const base = { id: 'G-SEND-1', employee: 'Pat Doe', steward: 'Sam', status: 'Pending', location: 'L1', actingUser: 'x', actorUsername: 'x' };
  const logRows = async () => (await pool.query('select data from email_log order by row_id')).rows.map(r => r.data);
  const reset = () => { sent.length = 0; plan = () => 'ok'; };

  // 1. Each of Steps 1, 2 and 3 emails every grievant address, once per step.
  reset();
  let r = await db.submitGrievance({ ...base, grievantEmail: 'pat@x.gov; pat.alt@y.gov', step1filed: '2026-06-01' });
  await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.deepStrictEqual(sent.map(x => x.to), ['pat@x.gov', 'pat.alt@y.gov'], 'Step 1: both addresses, semicolon-separated list accepted');
  assert.ok(sent.every(x => x.subject.includes('Step 1')));

  reset();
  r = await db.submitGrievance({ ...base, grievantEmail: 'pat@x.gov; pat.alt@y.gov', step1filed: '2026-06-01', step2filed: '2026-06-20' });
  await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.strictEqual(sent.length, 2, 'Step 2: one email per address');
  assert.ok(sent.every(x => x.subject.includes('Step 2')));

  reset();
  r = await db.submitGrievance({ ...base, grievantEmail: 'pat@x.gov; pat.alt@y.gov', step1filed: '2026-06-01', step2filed: '2026-06-20', step3filed: '2026-07-10' });
  await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.strictEqual(sent.length, 2, 'Step 3: one email per address');
  assert.ok(sent.every(x => x.subject.includes('Step 3')));
  console.log('✓ Steps 1, 2 and 3 each email every grievant address once (semicolon or comma separated)');

  // 2. A temporary Brevo failure is retried, and the email still goes out.
  reset();
  const attempts = {};
  plan = (to) => { attempts[to] = (attempts[to] || 0) + 1; return attempts[to] < 3 ? 'Brevo API error (503): unavailable' : 'ok'; };
  r = await db.submitGrievance({ ...base, id: 'G-SEND-2', grievantEmail: 'retry@x.gov', step1filed: '2026-07-01' });
  let s = await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.strictEqual(attempts['retry@x.gov'], 3, 'two temporary failures then success = three attempts');
  assert.strictEqual(s.errors.length, 0, 'a retried send that succeeds is not an error');
  const okRow = (await logRows()).filter(e => e.gid === 'G-SEND-2' && e.ok === true);
  assert.strictEqual(okRow.length, 1, 'logged as sent once');
  console.log('✓ A temporary mail failure is retried until it succeeds');

  // 3. A rejected address is not retried, and the failure is logged.
  reset();
  attempts.bad = 0;
  plan = (to) => { attempts[to] = (attempts[to] || 0) + 1; return to === 'bad@x.gov' ? 'Brevo API error (400): invalid email address' : 'ok'; };
  r = await db.submitGrievance({ ...base, id: 'G-SEND-3', grievantEmail: 'bad@x.gov', step1filed: '2026-07-05' });
  s = await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.strictEqual(attempts['bad@x.gov'], 1, 'a rejected address is tried once');
  assert.strictEqual(s.errors.length, 1);
  assert.ok((await logRows()).some(e => e.gid === 'G-SEND-3' && e.ok === false), 'the failure is logged');
  assert.strictEqual(gn.isTransientMailError(new Error('Brevo API error (429): slow down')), true);
  assert.strictEqual(gn.isTransientMailError(new Error('Brevo API error (400): bad')), false);
  console.log('✓ A rejected address is not retried, and the failure is logged');

  // 4. No grievant address on file: nothing is sent.
  reset();
  r = await db.submitGrievance({ ...base, id: 'G-SEND-4', grievantEmail: '', step1filed: '2026-07-09' });
  s = await gn.sendGrievantStepNotifications(r.record, r.newlyFiledSteps);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(s.skippedNoEmail, true);
  console.log('✓ No grievant address on file: nothing is sent');

  console.log('\nALL GRIEVANT SEND TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
