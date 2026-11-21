const assert = require('assert');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Shared contact links: one link per location, not personal. Many people can use
// it, each entering their own details. Stewards see the submissions. Checked over
// real HTTP with pg-mem as the database.

function request(port, method, pathname, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: raw, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

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
  `);
  await pool.query(`insert into setup_lists (key, items) values ('Location', '["North Suburban FCRC","NorthSide FCRC"]')`);
  await pool.query(`insert into app_meta (key, value) values ('orgLocalNo', '2858')`);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({ username: 'steward1', displayName: 'Steward One', password: 'stewardpass1', role: 'steward' });
  await db.upsertUser({ username: 'viewer1', displayName: 'Viewer One', password: 'viewerpass1', role: 'read_only' });
  await db.upsertUser({ username: 'plus1', displayName: 'Plus One', password: 'pluspass1', role: 'steward_plus', locations: ['NorthSide FCRC'] });

  // Stub the mail service and record every message.
  const sentMail = [];
  const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
  require.cache[mailerPath] = { id: mailerPath, filename: mailerPath, loaded: true, exports: {
    sendMail: async (args) => { sentMail.push({ to: args.to, subject: args.subject, text: args.text }); return { ok: true }; } } };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'noreply@example.gov';
  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const ip = n => ({ 'X-Forwarded-For': `10.0.0.${n}` });

  try {
    const login = async (u, p) => {
      const r = await request(port, 'POST', '/api/auth/login', { body: { username: u, password: p } });
      return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
    };
    const steward = await login('steward1', 'stewardpass1');
    const viewer = await login('viewer1', 'viewerpass1');
    const plus = await login('plus1', 'pluspass1');
    const tokenOf = url => url.split('/contact/')[1];

    // 1. A steward creates the one shared link. It carries no location and no name.
    const made = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} });
    assert.strictEqual(made.status, 200, JSON.stringify(made.json));
    assert.ok(!('location' in made.json) && !('memberName' in made.json), 'the link carries no location or name');
    const token = tokenOf(made.json.url);
    assert.ok(/^[a-f0-9]{48}$/.test(token));
    const stored = await pool.query('select token_hash from contact_links');
    assert.ok(stored.rows.every(r => r.token_hash !== token), 'the raw token is never stored');
    console.log('✓ A steward creates one shared link; only a hash of the token is stored');

    // 2. The form offers a drop-down of the existing locations, and no name.
    const page = await request(port, 'GET', '/contact/' + token);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('<select id="location"'), 'a location drop-down is on the form');
    assert.ok(page.text.includes('<option value="North Suburban FCRC">') && page.text.includes('<option value="NorthSide FCRC">'), 'the existing locations are offered');
    assert.ok(!/Hello|Contact details for/.test(page.text), 'the form is not personalised');
    assert.ok(page.text.includes('id="website"'), 'hidden trap field is present');
    assert.ok(page.text.includes('Local 2858'), 'the local number is in the header');
    assert.ok(page.text.includes('Developed by Hazem Albassam'), 'the developer credit is shown');
    console.log('✓ The link opens a form with a drop-down of the existing locations and no name');

    // 3. Refused entries say why and do not use up the link.
    const r1 = await request(port, 'POST', '/contact/' + token, { headers: ip(1), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '3125550100', consent: false } });
    assert.strictEqual(r1.status, 400, 'no consent is refused');
    const r2 = await request(port, 'POST', '/contact/' + token, { headers: ip(2), body: { legalName: 'Ann Lee', phone: '3125550100', consent: true } });
    assert.strictEqual(r2.status, 400, 'no location is refused');
    assert.ok(/location/i.test(r2.json.error));
    const r3 = await request(port, 'POST', '/contact/' + token, { headers: ip(3), body: { location: 'Mars Office', legalName: 'Ann Lee', phone: '3125550100', consent: true } });
    assert.strictEqual(r3.status, 400, 'a location outside the list is refused');
    const r4 = await request(port, 'POST', '/contact/' + token, { headers: ip(4), body: { location: 'NorthSide FCRC', legalName: 'A', phone: '3125550100', consent: true } });
    assert.strictEqual(r4.status, 400, 'a one-letter name is refused');
    const r5 = await request(port, 'POST', '/contact/' + token, { headers: ip(5), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', consent: true } });
    assert.strictEqual(r5.status, 400, 'no phone and no email is refused');
    console.log('✓ Refused entries explain why');

    // 4. Several people use the same link and each chooses their own location.
    const a = await request(port, 'POST', '/contact/' + token, { headers: ip(6), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '(312) 555-0100', personalEmail: 'ann@personal.example', stateEmail: 'ann.lee@state.example', consent: true } });
    assert.strictEqual(a.status, 200, JSON.stringify(a.json));
    const b = await request(port, 'POST', '/contact/' + token, { headers: ip(7), body: { location: 'North Suburban FCRC', legalName: 'Ben Ortiz', phone: '3125550199', consent: true } });
    assert.strictEqual(b.status, 200, JSON.stringify(b.json));
    const rows = (await pool.query('select legal_name, location from contact_submissions order by legal_name')).rows;
    assert.deepStrictEqual(rows.map(r => [r.legal_name, r.location]), [['Ann Lee', 'NorthSide FCRC'], ['Ben Ortiz', 'North Suburban FCRC']], 'each person keeps their own location');
    console.log('✓ One link serves many people; each person chooses and keeps their own location');

    // 4b. The same person submitting again (same name, and a matching phone or email)
    //     updates their entry rather than adding a second one.
    const again = await request(port, 'POST', '/contact/' + token, { headers: ip(11), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '312.555.0100', personalEmail: 'ANN@personal.example', consent: true } });
    assert.strictEqual(again.status, 200, JSON.stringify(again.json));
    assert.strictEqual(again.json.updated, true, 'a repeat submission is treated as an update');
    const annRows = (await pool.query("select legal_name, state_email from contact_submissions where legal_name = 'Ann Lee'")).rows;
    assert.strictEqual(annRows.length, 1, 'still one entry for Ann');
    assert.strictEqual(annRows[0].state_email, '', 'the newest submission replaces the old details');
    // A different person who shares Ann's phone number is a new entry, and Ann's is not overwritten.
    const sharer = await request(port, 'POST', '/contact/' + token, { headers: ip(12), body: { location: 'NorthSide FCRC', legalName: 'Dana Lee', phone: '312.555.0100', consent: true } });
    assert.strictEqual(sharer.status, 200);
    assert.ok(!sharer.json.updated, 'a different name is a new entry, even with a shared phone');
    const both = (await pool.query("select legal_name from contact_submissions where legal_name in ('Ann Lee','Dana Lee') order by legal_name")).rows;
    assert.deepStrictEqual(both.map(r => r.legal_name), ['Ann Lee', 'Dana Lee'], 'both people are kept');
    console.log('✓ A repeat submission (same name, matching phone or email) updates that entry; a different person sharing a phone is kept separately');

    // 5. A filled-in hidden field is treated as a bot: it reports success and saves nothing.
    const bot = await request(port, 'POST', '/contact/' + token, { headers: ip(8), body: { location: 'NorthSide FCRC', legalName: 'Bot Name', phone: '3125550123', consent: true, website: 'spam' } });
    assert.strictEqual(bot.status, 200);
    assert.strictEqual((await pool.query("select count(*)::int as n from contact_submissions where legal_name='Bot Name'")).rows[0].n, 0, 'bot entries are not saved');
    console.log('✓ A bot that fills the hidden field gets a success message but nothing is saved');

    // 6. Too many submissions from one connection are refused for a while.
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const r = await request(port, 'POST', '/contact/' + token, { headers: ip(9), body: { location: 'NorthSide FCRC', legalName: 'Flood Test', phone: '3125550177', consent: true } });
      if (r.status === 429) { limited = r; break; }
    }
    assert.ok(limited, 'repeated submissions from one connection are limited');
    console.log('✓ Repeated submissions from one connection are limited (429)');

    // 7. A new link replaces the old one.
    const newer = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} });
    const newToken = tokenOf(newer.json.url);
    assert.strictEqual((await request(port, 'GET', '/contact/' + token)).status, 410, 'the old link stops working');
    assert.strictEqual((await request(port, 'GET', '/contact/' + newToken)).status, 200, 'the new link works');
    console.log('✓ A new link replaces the old one');

    // 8. Revoking stops the link at once; an expired link is refused.
    await request(port, 'POST', '/api/member-contacts/revoke', { cookie: plus, body: {} });
    assert.strictEqual((await request(port, 'GET', '/contact/' + newToken)).status, 410, 'a revoked link is refused');
    assert.strictEqual((await request(port, 'POST', '/contact/' + newToken, { headers: ip(10), body: { location: 'NorthSide FCRC', legalName: 'Late Entry', phone: '3125550111', consent: true } })).status, 400, 'a revoked link cannot submit');
    const third = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} });
    const thirdToken = tokenOf(third.json.url);
    await pool.query("update contact_links set expires_at = now() - interval '1 minute' where token_hash = $1", [crypto.createHash('sha256').update(thirdToken).digest('hex')]);
    assert.strictEqual((await request(port, 'GET', '/contact/' + thirdToken)).status, 410, 'an expired link is refused');
    assert.strictEqual((await request(port, 'GET', '/contact/' + 'a'.repeat(48))).status, 404, 'an unknown link is not found');
    console.log('✓ Revoked and expired links are refused');

    // 9. Stewards see submissions and whether a link is live; read-only accounts see nothing.
    const none = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.strictEqual(none.json.activeLink, null, 'no link is live after revoking');
    const live = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} });
    const liveList = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.ok(liveList.json.activeLink && liveList.json.activeLink.expiresAt, 'a live link is shown');
    assert.ok(liveList.json.submissions.some(s => s.legalName === 'Ann Lee' && s.location === 'NorthSide FCRC' && s.stateEmail === ''), 'submissions show location and details');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts', { cookie: viewer })).status, 200, 'a read-only account can view the list');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/remove', { cookie: viewer, body: { id: 'x' } })).status, 403, 'a read-only account cannot remove entries');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts/export', { cookie: viewer })).status, 403, 'a read-only account cannot export');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: viewer, body: {} })).status, 403, 'a read-only account cannot create links');
    console.log('✓ Stewards see submissions and whether the link is live; read-only accounts cannot');

    // 9b. Other stewards can view, export and create the link, but not edit.
    const stewardEdit = (await request(port, 'POST', '/api/member-contacts/remove', { cookie: steward, body: { id: 'x' } }));
    assert.strictEqual(stewardEdit.status, 403, 'a steward cannot remove entries');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/revoke', { cookie: steward, body: {} })).status, 403, 'a steward cannot revoke the link');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/send-update', { cookie: steward, body: { id: 'x' } })).status, 403, 'a steward cannot send update links');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts', { cookie: steward })).status, 200, 'a steward can view');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} })).status, 200, 'a steward can create the link');
    console.log('✓ Other stewards can view, export and create the link, but cannot remove, revoke, or send update links');

    // 10. Removing one person's entry leaves the others.
    const ann = liveList.json.submissions.find(s => s.legalName === 'Ann Lee');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/remove', { cookie: plus, body: { id: ann.id } })).status, 200);
    const after = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.ok(!after.json.submissions.some(s => s.legalName === 'Ann Lee'), 'the chosen entry is removed');
    assert.ok(after.json.submissions.some(s => s.legalName === 'Ben Ortiz'), 'other entries are kept');
    console.log('✓ Removing one entry leaves the others');
    // 11. A steward sends an update link to a person's personal email. (Ann was removed above,
    //     so put her entry back directly for this part.)
    await pool.query(`insert into contact_submissions (id, location, legal_name, phone, personal_email, state_email) values ('ann-upd', 'NorthSide FCRC', 'Ann Lee', '312.555.0100', 'ANN@personal.example', '')`);
    const ann2 = (await request(port, 'GET', '/api/member-contacts', { cookie: steward })).json.submissions.find(s => s.legalName === 'Ann Lee');
    const sent = await request(port, 'POST', '/api/member-contacts/send-update', { cookie: plus, body: { id: ann2.id } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.json));
    const mail = sentMail[sentMail.length - 1];
    assert.strictEqual(mail.to.toLowerCase(), 'ann@personal.example', 'the link goes to the personal email on file');
    const updToken = (mail.text.match(/\/update\/([a-f0-9]{48})/) || [])[1];
    assert.ok(updToken, 'the email contains the update link');
    assert.ok((await pool.query('select token_hash from contact_update_links')).rows.every(r => r.token_hash !== updToken), 'the raw update token is never stored');
    console.log('✓ A steward sends an update link to the personal email on file, and only a hash is stored');

    // 12. The update form opens blank: no existing details are shown.
    const updPage = await request(port, 'GET', '/update/' + updToken);
    assert.strictEqual(updPage.status, 200);
    assert.ok(updPage.text.includes('Update your contact details'));
    assert.ok(!/ann@personal|312\.555\.0100|Ann Lee/.test(updPage.text), 'no existing details are shown on the form');
    console.log('✓ The update form opens blank');

    // 13. A refused update does not use up the link.
    const badUpd = await request(port, 'POST', '/update/' + updToken, { headers: ip(13), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '3125550111', consent: false } });
    assert.strictEqual(badUpd.status, 400);
    assert.strictEqual((await request(port, 'GET', '/update/' + updToken)).status, 200, 'the link still works after a refused update');
    console.log('✓ A refused update does not use up the link');

    // 14. A valid update changes the same entry, and the new email gets a confirmation.
    const okUpd = await request(port, 'POST', '/update/' + updToken, { headers: ip(14), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '(312) 555-0111', personalEmail: 'ann.new@personal.example', consent: true } });
    assert.strictEqual(okUpd.status, 200, JSON.stringify(okUpd.json));
    const same = (await pool.query("select id, phone, personal_email from contact_submissions where legal_name = 'Ann Lee'")).rows;
    assert.strictEqual(same.length, 1, 'still one entry for Ann');
    assert.strictEqual(same[0].id, ann2.id, 'the same entry is updated');
    assert.strictEqual(same[0].phone, '(312) 555-0111');
    assert.strictEqual(same[0].personal_email, 'ann.new@personal.example');
    for (let i = 0; i < 20 && !sentMail.some(m => m.to === 'ann.new@personal.example'); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(sentMail.some(m => m.to === 'ann.new@personal.example' && /updated/.test(m.subject)), 'the new email gets a confirmation');
    console.log('✓ A valid update changes the same entry, and the new email gets a confirmation');

    // 15. The link cannot be used again.
    assert.strictEqual((await request(port, 'POST', '/update/' + updToken, { headers: ip(15), body: { location: 'NorthSide FCRC', legalName: 'Ann Lee', phone: '3125550111', consent: true } })).status, 400, 'a used link is refused');
    assert.strictEqual((await request(port, 'GET', '/update/' + updToken)).status, 410, 'a used link shows as no longer valid');
    console.log('✓ An update link works once');

    // 16. An expired link is refused.
    await request(port, 'POST', '/api/member-contacts/send-update', { cookie: plus, body: { id: ann2.id } });
    const oldToken = (sentMail[sentMail.length - 1].text.match(/\/update\/([a-f0-9]{48})/) || [])[1];
    await pool.query("update contact_update_links set expires_at = now() - interval '1 minute' where token_hash = $1", [crypto.createHash('sha256').update(oldToken).digest('hex')]);
    assert.strictEqual((await request(port, 'GET', '/update/' + oldToken)).status, 410, 'an expired update link is refused');
    console.log('✓ An expired update link is refused');

    // 17. A person with no personal email cannot be sent a link; read-only accounts cannot send one.
    const dana = (await request(port, 'GET', '/api/member-contacts', { cookie: steward })).json.submissions.find(s => s.legalName === 'Dana Lee');
    const noEmail = await request(port, 'POST', '/api/member-contacts/send-update', { cookie: plus, body: { id: dana.id } });
    assert.strictEqual(noEmail.status, 400, 'no personal email means no link');
    assert.ok(/no personal email/i.test(noEmail.json.error));
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/send-update', { cookie: viewer, body: { id: ann2.id } })).status, 403, 'read-only accounts cannot send links');
    console.log('✓ No link without a personal email on file; read-only accounts cannot send links');

    // 18. If email is not configured, no link is created.
    const before = (await pool.query('select count(*)::int as n from contact_update_links')).rows[0].n;
    delete process.env.BREVO_API_KEY;
    const unconfigured = await request(port, 'POST', '/api/member-contacts/send-update', { cookie: plus, body: { id: ann2.id } });
    process.env.BREVO_API_KEY = 'test-key';
    assert.strictEqual(unconfigured.status, 400);
    assert.ok(/not configured/i.test(unconfigured.json.error));
    assert.strictEqual((await pool.query('select count(*)::int as n from contact_update_links')).rows[0].n, before, 'no link is created when email is not configured');
    console.log('✓ Without email configured, no link is created and the steward is told why');
    // 19. Export: all members, or one location; spreadsheet-safe; audited; stewards only.
    await pool.query(`insert into contact_submissions (id, location, legal_name, phone, personal_email, state_email) values ('exp-1', 'NorthSide FCRC', 'Smith, Jo', '3125550123', 'jo@x.gov', '')`);
    await pool.query(`insert into contact_submissions (id, location, legal_name, phone, personal_email, state_email) values ('exp-2', 'NorthSide FCRC', '=HYPERLINK("http://bad.example")', '', 'evil@x.gov', '')`);
    const all = await request(port, 'GET', '/api/member-contacts/export', { cookie: steward });
    assert.strictEqual(all.status, 200, all.text.slice(0, 120));
    assert.ok(/text\/csv/.test(all.headers['content-type']), 'served as CSV');
    assert.ok(/attachment; filename="members-all-\d{4}-\d{2}-\d{2}\.csv"/.test(all.headers['content-disposition']), 'downloads as an attachment');
    assert.ok(all.text.startsWith('\uFEFF'), 'has a byte-order mark so Excel reads the names');
    assert.ok(all.text.includes('Submitted,Location,Legal name,Phone,Personal email,State email'), 'header row');
    assert.ok(all.text.includes('"Smith, Jo"'), 'commas are quoted');
    assert.ok(all.text.includes("'=HYPERLINK"), 'formula-like values are neutralised');
    assert.ok(!/(^|\r\n)=HYPERLINK/.test(all.text), 'no cell starts with a bare formula');
    const north = await request(port, 'GET', '/api/member-contacts/export?location=' + encodeURIComponent('North Suburban FCRC'), { cookie: steward });
    assert.strictEqual(north.status, 200);
    assert.ok(/members-north-suburban-fcrc-/.test(north.headers['content-disposition']), 'the file name names the location');
    assert.ok(north.text.includes('Ben Ortiz') && !north.text.includes('Smith, Jo'), 'only that location is exported');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts/export?location=Mars', { cookie: steward })).status, 400, 'a location outside the list is refused');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts/export', { cookie: viewer })).status, 403, 'read-only accounts cannot export');
    const logged = (await pool.query("select detail from audit_log where action = 'member_export' order by id")).rows.map(r => r.detail);
    assert.ok(logged.some(d => /all/.test(d)) && logged.some(d => /North Suburban/.test(d)), 'each export is recorded in the audit log: ' + JSON.stringify(logged));
    console.log('✓ Export: all or one location, spreadsheet-safe, stewards only, and every export is audited');
  } finally {
    server.close();
  }
  console.log('\nALL MEMBER CONTACT TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
