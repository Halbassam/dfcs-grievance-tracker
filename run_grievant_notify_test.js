const assert = require('assert');
const path = require('path');
const http = require('http');

async function setupDb() {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();
  const poolPath = path.resolve('/home/claude/dfcs-rebuild/server/pool.js');
  const dbPath = path.resolve('/home/claude/dfcs-rebuild/server/db.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool, query: (t,p) => pool.query(t,p),
      withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
    }
  };
  delete require.cache[dbPath];
  await pool.query(`
    create table grievances (id text primary key, status text not null default 'Pending', steward text, data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table activity (row_id serial primary key, gid text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table archive (id text primary key, status text, steward text, archived_at text, data jsonb not null default '{}', created_at timestamptz not null default now());
    create table users (username text primary key, display_name text not null, password_hash text not null, role text not null default 'steward', created_at timestamptz not null default now());
    create table sessions (token text primary key, username text not null, expires_at timestamptz not null);
    create table holidays (date text primary key, name text not null);
    create table setup_lists (key text primary key, items jsonb not null default '[]');
    create table email_log (row_id serial primary key, run_at timestamptz not null default now(), data jsonb not null default '{}');
    create table app_meta (key text primary key, value text);
  `);
  return require(dbPath);
}

async function testMissingManagementEmail() {
  const db = await setupDb();
  await db.submitGrievance({ id: '2026-c1', employee: 'Test', steward: 'Hazem', status: 'Pending', step1filed: '2026-06-01', actingUser: 'Hazem' });
  try {
    await db.sendCourtesyNotice('2026-c1', 'step1');
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('management contact'), 'should clearly say no management email is set, got: ' + err.message);
    console.log('✓ sendCourtesyNotice rejects clearly when no management email is configured in Settings');
  }
}

async function testMissingBrevoConfig() {
  const db = await setupDb();
  await db.updateOrgSettings({ managementEmail: 'super@illinois.gov' });
  await db.submitGrievance({ id: '2026-c2', employee: 'Test', steward: 'Hazem', status: 'Pending', step1filed: '2026-06-01', actingUser: 'Hazem' });
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  try {
    await db.sendCourtesyNotice('2026-c2', 'step1');
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('not configured') || err.message.includes('BREVO'), 'should clearly say email is not configured, got: ' + err.message);
    console.log('✓ sendCourtesyNotice rejects clearly when Brevo is not configured');
  }
}

async function testInvalidStep() {
  const db = await setupDb();
  try {
    await db.sendCourtesyNotice('2026-anything', 'step3');
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('step1') || err.message.toLowerCase().includes('step 1'), 'should reject step3, got: ' + err.message);
    console.log('✓ sendCourtesyNotice correctly rejects step3 (only step1/step2 are valid)');
  }
}

async function testGrievanceNotFound() {
  const db = await setupDb();
  await db.updateOrgSettings({ managementEmail: 'super@illinois.gov' });
  process.env.BREVO_API_KEY = 'fake';
  process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';
  try {
    await db.sendCourtesyNotice('2026-doesnotexist', 'step1');
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('not found'), 'should say grievance not found, got: ' + err.message);
    console.log('✓ sendCourtesyNotice correctly rejects a non-existent grievance ID');
  }
}

async function testNoDeadlineYet() {
  const db = await setupDb();
  await db.updateOrgSettings({ managementEmail: 'super@illinois.gov' });
  process.env.BREVO_API_KEY = 'fake';
  process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';
  // No step1filed at all -> no computable deadline
  await db.submitGrievance({ id: '2026-c3', employee: 'Test', steward: 'Hazem', status: 'Pending', actingUser: 'Hazem' });
  try {
    await db.sendCourtesyNotice('2026-c3', 'step1');
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('deadline'), 'should say no deadline could be calculated, got: ' + err.message);
    console.log('✓ sendCourtesyNotice correctly rejects when there is no computable deadline yet (step not filed)');
  }
}

async function testOneTimeEnforcement() {
  // This test needs an actual successful send, which needs a real
  // network call to Brevo -- we can't do that safely in a unit test.
  // Instead we directly manipulate the "already sent" flag to prove
  // the enforcement check itself works correctly, which is the
  // security-relevant part (can't send twice).
  const db = await setupDb();
  await db.updateOrgSettings({ managementEmail: 'super@illinois.gov' });
  process.env.BREVO_API_KEY = 'fake';
  process.env.BREVO_SENDER_EMAIL = 'sender@x.gov';
  const g = await db.submitGrievance({
    id: '2026-c4', employee: 'Test', steward: 'Hazem', status: 'Pending',
    step1filed: '2026-06-01', actingUser: 'Hazem'
  });

  // Manually mark it as already sent, simulating a prior successful send
  const all = await db.getAll();
  const rec = all.grievances.find(r => r.id === '2026-c4');
  // Directly update via a raw query since there's no dedicated setter --
  // this mirrors exactly what sendCourtesyNotice itself would persist.
  const { query } = require('/home/claude/dfcs-rebuild/server/pool.js');
  await query(
    `update grievances set data = $2::jsonb where id = $1`,
    ['2026-c4', JSON.stringify({ ...rec, step1CourtesySent: true })]
  );

  try {
    await db.sendCourtesyNotice('2026-c4', 'step1');
    throw new Error('expected rejection — a second send for the same step must be blocked');
  } catch (err) {
    assert.ok(err.message.includes('already been sent'), 'should say it was already sent, got: ' + err.message);
    console.log('✓ sendCourtesyNotice is correctly blocked from sending a second courtesy notice for the same step (server-side enforcement, not just UI)');
  }
}

async function testFrontendButtonVisibility() {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  let html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__t3 = {
      courtesyNoticeSectionHtml: (rec, d) => courtesyNoticeSectionHtml(rec, d),
      deriveDeadlines: (rec) => deriveDeadlines(rec)
    };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));

  // Case 1: Step 1 filed, no response, not sent yet -> button should appear
  const rec1 = { id: '2026-f1', status: 'Pending', step1filed: '2026-06-01' };
  const d1 = w.__t3.deriveDeadlines(rec1);
  const html1 = w.__t3.courtesyNoticeSectionHtml(rec1, d1);
  assert.ok(html1.includes('courtesyStep1Btn'), 'button should appear for an eligible, not-yet-sent Step 1 deadline');
  console.log('✓ Frontend: Step 1 courtesy button appears when eligible and not yet sent');

  // Case 2: already sent -> button should NOT appear, should show sent note instead
  const rec2 = { ...rec1, step1CourtesySent: true };
  const html2 = w.__t3.courtesyNoticeSectionHtml(rec2, d1);
  assert.ok(!html2.includes('courtesyStep1Btn'), 'button must NOT appear once already sent');
  assert.ok(html2.includes('already sent'), 'should show an "already sent" note instead');
  console.log('✓ Frontend: Step 1 button correctly disappears once marked as sent, replaced with a sent notice');

  // Case 3: resolved grievance -> no courtesy section at all
  const rec3 = { ...rec1, status: 'Settled' };
  const html3 = w.__t3.courtesyNoticeSectionHtml(rec3, d1);
  assert.strictEqual(html3, '', 'a resolved grievance should show no courtesy notice section at all');
  console.log('✓ Frontend: resolved grievances show no courtesy notice section');

  // Case 4: Step 1 not filed at all -> no button (nothing to remind about)
  const rec4 = { id: '2026-f4', status: 'Pending' };
  const d4 = w.__t3.deriveDeadlines(rec4);
  const html4 = w.__t3.courtesyNoticeSectionHtml(rec4, d4);
  assert.ok(!html4.includes('courtesyStep1Btn'), 'no button should appear when Step 1 was never filed');
  console.log('✓ Frontend: no button appears for a step that was never filed (nothing to send a reminder about)');
}

(async () => {
  try {
    await testMissingManagementEmail();
    await testMissingBrevoConfig();
    await testInvalidStep();
    await testGrievanceNotFound();
    await testNoDeadlineYet();
    await testOneTimeEnforcement();
    await testFrontendButtonVisibility();
    console.log('\nALL COURTESY NOTICE TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
