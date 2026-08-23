const assert = require('assert');
const path = require('path');
const http = require('http');

async function testNewlyFiledDetection() {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();
  const poolPath = path.resolve('/home/claude/dfcs-rebuild/server/pool.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool, query: (t,p) => pool.query(t,p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
    }
  };
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  `);
  const db = require('/home/claude/dfcs-rebuild/server/db.js');

  // First save: new grievance, Step 1 filed immediately.
  const g1 = await db.submitGrievance({
    id: '2026-500', employee: 'Jane Doe', grievantEmail: 'jane@example.gov',
    steward: 'Hazem', status: 'Pending', step1filed: '2026-06-01', actingUser: 'Hazem'
  });
  assert.strictEqual(g1.newlyFiledSteps.step1, true, 'Step 1 should be detected as newly filed on creation');
  assert.strictEqual(g1.newlyFiledSteps.step2, false);
  assert.strictEqual(g1.newlyFiledSteps.step3, false);
  assert.strictEqual(g1.record.grievantEmail, 'jane@example.gov');
  console.log('✓ Step 1 correctly detected as newly filed when set on grievance creation');

  // Second save: same grievance, no new dates -- nothing should be "newly filed"
  const g2 = await db.submitGrievance({
    id: '2026-500', employee: 'Jane Doe', grievantEmail: 'jane@example.gov',
    steward: 'Hazem', status: 'Pending', actingUser: 'Hazem'
  });
  assert.strictEqual(g2.newlyFiledSteps.step1, false, 'Step 1 already had a date -- must NOT re-trigger on a save that does not change it');
  console.log('✓ Re-saving without changing dates does NOT re-trigger a "newly filed" notification (no duplicate emails)');

  // Third save: now add step2filed -- only step2 should be newly filed
  const g3 = await db.submitGrievance({
    id: '2026-500', employee: 'Jane Doe', grievantEmail: 'jane@example.gov',
    steward: 'Hazem', status: 'Pending', step2filed: '2026-06-20', actingUser: 'Hazem'
  });
  assert.strictEqual(g3.newlyFiledSteps.step1, false, 'Step 1 was already filed before this save');
  assert.strictEqual(g3.newlyFiledSteps.step2, true, 'Step 2 is newly filed in this save');
  assert.strictEqual(g3.newlyFiledSteps.step3, false);
  console.log('✓ Adding Step 2 filed date correctly triggers ONLY the step2 notification flag, not step1 again');

  // Fourth save: add BOTH step3filed while step1/step2 stay set -- only step3 true
  const g4 = await db.submitGrievance({
    id: '2026-500', employee: 'Jane Doe', grievantEmail: 'jane@example.gov',
    steward: 'Hazem', status: 'Pending', step3filed: '2026-07-10', actingUser: 'Hazem'
  });
  assert.strictEqual(g4.newlyFiledSteps.step1, false);
  assert.strictEqual(g4.newlyFiledSteps.step2, false);
  assert.strictEqual(g4.newlyFiledSteps.step3, true, 'Step 3 is newly filed in this save');
  console.log('✓ Adding Step 3 filed date correctly triggers ONLY the step3 notification flag');
}

async function testEmailContent() {
  const { buildStepEmailBody, parseEmailList } = require('/home/claude/dfcs-rebuild/server/grievantNotify.js');

  // parseEmailList handles comma-separated group grievance emails
  assert.deepStrictEqual(parseEmailList('a@x.gov, b@y.gov,c@z.gov'), ['a@x.gov', 'b@y.gov', 'c@z.gov']);
  assert.deepStrictEqual(parseEmailList(''), []);
  assert.deepStrictEqual(parseEmailList('   '), []);
  assert.deepStrictEqual(parseEmailList('not-an-email, valid@x.gov'), ['valid@x.gov']);
  console.log('✓ parseEmailList correctly splits comma-separated group-grievance emails and filters invalid entries');

  const rec = { id: '2026-500', employee: 'Jane Doe' };

  const step1Body = buildStepEmailBody(rec, 'step1');
  assert.ok(step1Body.includes('Step 1'), 'Step 1 email should mention Step 1');
  assert.ok(step1Body.includes('10 working days'), 'Step 1 email should include the response timeframe');
  console.log('✓ Step 1 email includes the expected response timeframe');

  const step2Body = buildStepEmailBody(rec, 'step2');
  assert.ok(step2Body.includes('Step 2'), 'Step 2 email should mention Step 2');
  assert.ok(step2Body.includes('15 working days'), 'Step 2 email should include the response timeframe');
  console.log('✓ Step 2 email includes the expected response timeframe');

  const step3Body = buildStepEmailBody(rec, 'step3');
  assert.ok(step3Body.includes('Step 3'), 'Step 3 email should mention Step 3');
  assert.ok(!/due within \d+ working days/.test(step3Body), 'Step 3 email must NOT include a specific response timeframe');
  assert.ok(!step3Body.toLowerCase().includes('expected response timeframe'), 'Step 3 email must not label any timeframe as "expected"');
  console.log('✓ Step 3 email correctly OMITS the expected response timeframe (per local policy)');
}

async function testSendingLogic() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: '<test@brevo.com>' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  // Monkey-patch mailer's https call target isn't feasible without editing
  // production code for a test hook, so instead we verify end-to-end
  // behavior using the REAL grievantNotify module against a REAL local
  // server by temporarily pointing BREVO env vars at test values and
  // relying on mailer.js's actual network call -- but since mailer.js
  // hardcodes api.brevo.com, we instead verify the skip/error paths that
  // don't require reaching the real API, which is what matters most for
  // correctness (no crashes, no silent double-sends, clear errors).
  const { sendGrievantStepNotifications } = require('/home/claude/dfcs-rebuild/server/grievantNotify.js');
  server.close();

  // No grievant email on file -> should skip cleanly, no error, no crash
  const noEmailResult = await sendGrievantStepNotifications(
    { id: '2026-501', employee: 'No Email Case', grievantEmail: '' },
    { step1: true, step2: false, step3: false }
  );
  assert.strictEqual(noEmailResult.skippedNoEmail, true);
  assert.strictEqual(noEmailResult.sent.length, 0);
  assert.strictEqual(noEmailResult.errors.length, 0);
  console.log('✓ A grievance with no grievantEmail on file is skipped cleanly -- no error, no crash');

  // No step newly filed -> nothing attempted at all
  const oldApiKey = process.env.BREVO_API_KEY;
  const oldSender = process.env.BREVO_SENDER_EMAIL;
  process.env.BREVO_API_KEY = 'fake_key_for_test';
  process.env.BREVO_SENDER_EMAIL = 'sender@example.gov';

  const nothingNewResult = await sendGrievantStepNotifications(
    { id: '2026-502', employee: 'Has Email', grievantEmail: 'grievant@x.gov' },
    { step1: false, step2: false, step3: false }
  );
  assert.strictEqual(nothingNewResult.attempted.length, 0, 'no steps newly filed -> nothing should be attempted');
  console.log('✓ When no step was newly filed in a save, no notification is attempted at all');

  process.env.BREVO_API_KEY = oldApiKey;
  process.env.BREVO_SENDER_EMAIL = oldSender;

  // Missing Brevo config entirely -> clean error, not a crash
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  const noConfigResult = await sendGrievantStepNotifications(
    { id: '2026-503', employee: 'Has Email', grievantEmail: 'grievant@x.gov' },
    { step1: true, step2: false, step3: false }
  );
  assert.ok(noConfigResult.errors.length > 0, 'missing Brevo config should produce a clear error, not silent failure');
  assert.ok(noConfigResult.errors[0].includes('BREVO_API_KEY') || noConfigResult.errors[0].includes('BREVO_SENDER_EMAIL'));
  console.log('✓ Missing Brevo configuration produces a clear error rather than crashing or silently doing nothing');
  if (oldApiKey) process.env.BREVO_API_KEY = oldApiKey;
  if (oldSender) process.env.BREVO_SENDER_EMAIL = oldSender;
}

(async () => {
  try {
    await testNewlyFiledDetection();
    await testEmailContent();
    await testSendingLogic();
    console.log('\nALL GRIEVANT NOTIFICATION TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
