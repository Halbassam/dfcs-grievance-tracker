const assert = require('assert');
const path = require('path');
const http = require('http');

// Newsletters: opt-in only, one email per person, personal or state addresses, unsubscribe
// links, a permanent unsubscribe unless the person opts back in, permissions, and one-year
// retention. The mail service is stubbed; the database is pg-mem.

function request(port, method, pathname, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, text: raw, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { newDb } = require('pg-mem');
  const pool = new (newDb().adapters.createPg().Pool)();
  const poolPath = path.resolve(__dirname, '..', 'server/pool.js');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
    pool, query: (t, p) => pool.query(t, p),
    withTransaction: async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } } } };
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
    create table contact_links (token_hash text primary key, created_by text not null default '', created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz);
    create table contact_update_links (token_hash text primary key, submission_id text not null, sent_to text not null default '', created_by text not null default '', created_at timestamptz not null default now(), expires_at timestamptz not null, used_at timestamptz);
    create table contact_submissions (id text primary key, location text not null, legal_name text not null default '', phone text not null default '', personal_email text not null default '', state_email text not null default '', consent_at timestamptz not null default now(), submitted_at timestamptz not null default now(), newsletter_opt_in boolean not null default false, newsletter_opt_in_at timestamptz, newsletter_unsubscribed_at timestamptz, unsubscribe_token text not null default '');
    create table newsletters (id text primary key, subject text not null, body text not null, audience text not null, location text not null default '', address_type text not null, reason text not null default '', sent_by text not null default '', created_at timestamptz not null default now(), finished_at timestamptz, recipients integer not null default 0, sent integer not null default 0, failed integer not null default 0, status text not null default 'sending');
  `);
  await pool.query(`insert into setup_lists (key, items) values ('Location', '["North Suburban FCRC","NorthSide FCRC"]')`);
  await pool.query(`insert into app_meta (key, value) values ('orgLocalNo', '2858')`);

  const sent = [];
  const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
  require.cache[mailerPath] = { id: mailerPath, filename: mailerPath, loaded: true, exports: {
    sendMail: async (args) => { sent.push(args); return { ok: true }; } } };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'noreply@example.gov';
  process.env.NEWSLETTER_TEST_EMAIL = 'tester@example.gov';

  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const nl = require(path.resolve(__dirname, '..', 'server/newsletter.js'));
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({ username: 'steward1', displayName: 'Steward One', password: 'stewardpass1', role: 'steward', locations: ['NorthSide FCRC'] });
  await db.upsertUser({ username: 'viewer1', displayName: 'Viewer One', password: 'viewerpass1', role: 'read_only' });
  await db.upsertUser({ username: 'plus1', displayName: 'Plus One', password: 'pluspass1', role: 'steward_plus', locations: ['NorthSide FCRC'] });

  const base = (name, location, email, state, news) => ({ location, legalName: name, phone: '3125550100', personalEmail: email, stateEmail: state, consent: true, newsletter: news });
  const { token: tok } = await db.createContactLink('admin1');
  await db.submitContact(tok, base('Ann Lee', 'NorthSide FCRC', 'ann@x.gov', '', true));
  await db.submitContact(tok, base('Ben Ortiz', 'NorthSide FCRC', 'ben@x.gov', '', false));
  await db.submitContact(tok, base('Cy Park', 'North Suburban FCRC', 'cy@x.gov', '', true));
  await db.submitContact(tok, base('Dee Ward', 'NorthSide FCRC', '', 'dee@state.gov', true));

  const who = async (opts) => (await db.getNewsletterRecipients(opts)).map(r => r.legalName).sort();
  assert.deepStrictEqual(await who({ location: 'NorthSide FCRC', addressType: 'personal' }), ['Ann Lee'], 'only opted-in people with a personal email');
  assert.deepStrictEqual(await who({ location: '', addressType: 'personal' }), ['Ann Lee', 'Cy Park'], 'the whole local, personal emails');
  assert.deepStrictEqual(await who({ location: 'NorthSide FCRC', addressType: 'state' }), ['Dee Ward'], 'state emails only for those who gave one');
  console.log('✓ Only people who opted in are chosen, and the address type decides which email is used');

  // Validation.
  assert.throws(() => nl.validateNewsletter({ subject: '', body: 'x', addressType: 'personal' }), /subject/);
  assert.throws(() => nl.validateNewsletter({ subject: 'Hi', body: 'x', addressType: 'state', reason: '' }), /special circumstances/);
  console.log('✓ A subject is required, and state emails need a reason');

  // Send one newsletter to NorthSide's personal emails. Wait for the background send to finish.
  const started = await nl.startNewsletter({ subject: 'June update', body: 'Meeting on Friday.\n\n<script>alert(1)</script>', audience: 'location', location: 'NorthSide FCRC', addressType: 'personal', sentBy: 'steward1', baseUrl: 'https://app.example', localNo: '2858' });
  assert.strictEqual(started.recipients, 1);
  for (let i = 0; i < 40; i++) {
    const row = (await pool.query('select status from newsletters where id = $1', [started.id])).rows[0];
    if (row && row.status === 'sent') break;
    await wait(100);
  }
  const mail = sent.filter(m => m.to === 'ann@x.gov');
  assert.strictEqual(mail.length, 1, 'one email to the one recipient');
  assert.ok(sent.every(m => m.to !== 'ben@x.gov'), 'a person who did not opt in is never emailed');
  assert.ok(mail[0].subject.includes('June update') && mail[0].subject.includes('2858'), 'subject carries the subject and the local');
  assert.ok(mail[0].html.includes('&lt;script&gt;'), 'the text is escaped, so it cannot inject markup');
  assert.ok(!mail[0].html.includes('<script>'), 'no raw script tag in the email');
  assert.ok(mail[0].html.includes('/unsubscribe/') && mail[0].text.includes('/unsubscribe/'), 'each email has an unsubscribe link');
  assert.strictEqual(mail[0].replyTo, 'local2858fcrc@gmail.com', 'replies go to the union address');
  const rec = (await db.listNewsletterRecords('steward1', false))[0];
  assert.strictEqual(rec.status, 'sent');
  assert.strictEqual(rec.sent, 1);
  assert.ok((await pool.query("select count(*)::int as n from email_log where data->>'kind' = 'newsletter'")).rows[0].n >= 1, 'each send is logged');
  console.log('✓ One email per person, escaped text, unsubscribe link, reply-to set, and the send is recorded and logged');

  // Unsubscribe is permanent until the person ticks the box again.
  const annRow = (await pool.query("select unsubscribe_token from contact_submissions where legal_name = 'Ann Lee'")).rows[0];
  assert.strictEqual(await db.unsubscribeByToken(annRow.unsubscribe_token), true);
  assert.deepStrictEqual(await who({ location: 'NorthSide FCRC', addressType: 'personal' }), [], 'an unsubscribed person is no longer chosen');
  await db.submitContact(tok, base('Ann Lee', 'NorthSide FCRC', 'ann@x.gov', '', false));
  assert.deepStrictEqual(await who({ location: 'NorthSide FCRC', addressType: 'personal' }), [], 'resubmitting without the box keeps them unsubscribed');
  await db.submitContact(tok, base('Ann Lee', 'NorthSide FCRC', 'ann@x.gov', '', true));
  assert.deepStrictEqual(await who({ location: 'NorthSide FCRC', addressType: 'personal' }), ['Ann Lee'], 'ticking the box again opts back in');
  console.log('✓ Unsubscribing is permanent until the person ticks the box again');

  // Test send goes to the test address only.
  sent.length = 0;
  const testRes = await nl.sendTest({ subject: 'Check', body: 'Hello', addressType: 'personal', baseUrl: 'https://app.example', localNo: '2858' });
  assert.strictEqual(testRes.sentTo, 'tester@example.gov');
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].subject.startsWith('TEST '), 'test emails are marked TEST');
  console.log('✓ A test send goes only to the test address');

  // One-year retention.
  await pool.query("insert into newsletters (id, subject, body, audience, address_type, created_at, status) values ('old-1', 'Old', 'x', 'all', 'personal', now() - interval '400 days', 'sent')");
  await db.purgeOldNewsletters();
  assert.strictEqual((await pool.query("select count(*)::int as n from newsletters where id = 'old-1'")).rows[0].n, 0, 'records older than a year are removed');
  console.log('✓ Newsletter records older than one year are removed');

  // Permissions over HTTP.
  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  try {
    const login = async (u, p) => {
      const r = await request(port, 'POST', '/api/auth/login', { body: { username: u, password: p } });
      return /dfcs_session=([^;]+)/.exec(r.headers ? '' : '') || null;
    };
    const cookieFor = async (u, p) => {
      const res = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ username: u, password: p });
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => { r.resume(); r.on('end', () => resolve(r.headers['set-cookie'][0])); });
        req.on('error', reject); req.write(data); req.end();
      });
      return /dfcs_session=([^;]+)/.exec(res)[0];
    };
    const steward = await cookieFor('steward1', 'stewardpass1');
    const viewer = await cookieFor('viewer1', 'viewerpass1');
    const admin = await cookieFor('admin1', 'adminpass1');
    const plus = await cookieFor('plus1', 'pluspass1');

    // Other stewards cannot send, preview or test; only admins and super stewards can.
    assert.strictEqual((await request(port, 'POST', '/api/newsletters/send', { cookie: steward, body: { subject: 'x', body: 'y', audience: 'location', location: 'NorthSide FCRC', addressType: 'personal' } })).status, 403, 'a steward cannot send a newsletter, even to their own location');
    assert.strictEqual((await request(port, 'POST', '/api/newsletters/preview', { cookie: steward, body: { audience: 'location', location: 'NorthSide FCRC', addressType: 'personal' } })).status, 403, 'a steward cannot preview a newsletter');
    assert.strictEqual((await request(port, 'POST', '/api/newsletters/test', { cookie: steward, body: { subject: 'x', body: 'y', addressType: 'personal' } })).status, 403, 'a steward cannot send a test');
    // A super steward can send to an assigned location, but not to the whole local.
    const plusAll = await request(port, 'POST', '/api/newsletters/send', { cookie: plus, body: { subject: 'x', body: 'y', audience: 'all', addressType: 'personal' } });
    assert.strictEqual(plusAll.status, 403, 'a super steward cannot send to the whole local');
    const plusOther = await request(port, 'POST', '/api/newsletters/send', { cookie: plus, body: { subject: 'x', body: 'y', audience: 'location', location: 'North Suburban FCRC', addressType: 'personal' } });
    assert.strictEqual(plusOther.status, 403, 'a super steward cannot send to another location');
    const plusOwn = await request(port, 'POST', '/api/newsletters/send', { cookie: plus, body: { subject: 'Super steward note', body: 'Hello', audience: 'location', location: 'NorthSide FCRC', addressType: 'personal' } });
    assert.strictEqual(plusOwn.status, 202, 'a super steward can send to an assigned location');
    const stewardHistoryOk = await request(port, 'GET', '/api/newsletters', { cookie: steward });
    assert.strictEqual(stewardHistoryOk.status, 200, 'a steward can read the newsletter history');
    assert.strictEqual((await request(port, 'POST', '/api/newsletters/send', { cookie: viewer, body: { subject: 'x', body: 'y', audience: 'all', addressType: 'personal' } })).status, 403, 'read-only accounts cannot send');
    assert.strictEqual((await request(port, 'GET', '/api/newsletters', { cookie: viewer })).status, 200, 'read-only accounts can read the history');
    assert.strictEqual((await request(port, 'POST', '/api/newsletters/send', { cookie: viewer, body: { subject: 'x', body: 'y', audience: 'all', addressType: 'personal' } })).status, 403, 'read-only accounts cannot send');
    const adminAll = await request(port, 'POST', '/api/newsletters/preview', { cookie: admin, body: { audience: 'all', addressType: 'personal' } });
    assert.strictEqual(adminAll.status, 200);
    assert.strictEqual(adminAll.json.recipients, 2, 'admin preview counts the whole local');
    const stewardHistory = await request(port, 'GET', '/api/newsletters', { cookie: steward });
    assert.ok(Array.isArray(stewardHistory.json.newsletters));
    const adminSeesAll = await request(port, 'GET', '/api/newsletters', { cookie: admin });
    assert.ok(adminSeesAll.json.newsletters.length >= 1);
    console.log('✓ Only admins and super stewards send (super stewards only to their location); other stewards and read-only accounts can read the history only');

    // The unsubscribe page and its button.
    const tokenNow = (await pool.query("select unsubscribe_token from contact_submissions where legal_name = 'Cy Park'")).rows[0].unsubscribe_token;
    const page = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/unsubscribe/' + tokenNow }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, text: d })); }).on('error', reject); });
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Unsubscribe from newsletters'), 'the unsubscribe page shows a button, and does nothing on open');
    const undo = await request(port, 'POST', '/unsubscribe/' + tokenNow);
    assert.strictEqual(undo.status, 200);
    assert.deepStrictEqual(await who({ location: 'North Suburban FCRC', addressType: 'personal' }), [], 'the unsubscribe button works');
    assert.strictEqual((await request(port, 'POST', '/unsubscribe/' + 'b'.repeat(32))).status, 404, 'an unknown unsubscribe link is refused');
    console.log('✓ The unsubscribe link opens a page; the button unsubscribes; unknown links are refused');
  } finally {
    server.close();
  }
  console.log('\nALL NEWSLETTER TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
