const assert = require('assert');
const path = require('path');
const http = require('http');

// Member contact links: a steward creates a one-time link, the member fills in
// their details, and only stewards can see them. Checked over real HTTP.

function request(port, method, pathname, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
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
    create table member_contacts (member_name text primary key, location text not null default '', legal_name text not null default '', phone text not null default '', personal_email text not null default '', state_email text not null default '', consent_at timestamptz, updated_at timestamptz not null default now(), updated_by text not null default '');
    create table member_links (token_hash text primary key, member_name text not null, location text not null default '', created_by text not null default '', created_at timestamptz not null default now(), expires_at timestamptz not null, used_at timestamptz);
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  await pool.query("insert into setup_lists (key, items) values ('Location', '[\"North Suburban FCRC\",\"NorthSide FCRC\"]')");
  await db.upsertUser({ username: 'admin1', displayName: 'Admin One', password: 'adminpass1' });
  await db.upsertUser({ username: 'steward1', displayName: 'Steward One', password: 'stewardpass1', role: 'steward' });
  await db.upsertUser({ username: 'viewer1', displayName: 'Viewer One', password: 'viewerpass1', role: 'read_only' });

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
      return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
    };
    const steward = await login('steward1', 'stewardpass1');
    const viewer = await login('viewer1', 'viewerpass1');

    // 1. A steward creates a link. The link is a path with a 48-character token.
    const noLoc = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { memberName: 'Pat Doe' } });
    assert.strictEqual(noLoc.status, 400, 'a link needs a location');
    const badLoc = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { memberName: 'Pat Doe', location: 'Mars Office' } });
    assert.strictEqual(badLoc.status, 400, 'a location must come from the location list');
    const made = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { memberName: '  Pat   Doe ', location: 'NorthSide FCRC' } });
    assert.strictEqual(made.status, 200, JSON.stringify(made.json));
    assert.strictEqual(made.json.memberName, 'Pat Doe', 'the member name is tidied');
    assert.strictEqual(made.json.location, 'NorthSide FCRC');
    const token = made.json.url.split('/member/')[1];
    assert.ok(/^[a-f0-9]{48}$/.test(token), 'token format');
    const stored = await pool.query('select token_hash from member_links');
    assert.ok(stored.rows.every(r => r.token_hash !== token), 'the raw token is never stored');
    console.log('✓ A steward creates a link; only a hash of the token is stored');

    // 2. The member opens the link and sees the form and the privacy notice.
    const page = await request(port, 'GET', '/member/' + token);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Hello Pat Doe'), 'the form greets the member by roster name');
    assert.ok(page.text.includes('How your details will be used'), 'the privacy notice is shown');
    assert.ok(page.text.includes('Legal name') && page.text.includes('Phone number') && page.text.includes('Personal email') && page.text.includes('State email'), 'all four fields are on the form');
    console.log('✓ The member link opens a form with the privacy notice and the four fields');

    // 3. Bad submissions are refused and do not use up the link.
    let bad = await request(port, 'POST', '/member/' + token, { body: { legalName: 'Pat Doe', phone: '3125550100', consent: false } });
    assert.strictEqual(bad.status, 400, 'no consent is refused');
    bad = await request(port, 'POST', '/member/' + token, { body: { legalName: 'P', phone: '3125550100', consent: true } });
    assert.strictEqual(bad.status, 400, 'a one-letter name is refused');
    bad = await request(port, 'POST', '/member/' + token, { body: { legalName: 'Pat Doe', consent: true } });
    assert.strictEqual(bad.status, 400, 'no phone and no email is refused');
    bad = await request(port, 'POST', '/member/' + token, { body: { legalName: 'Pat Doe', phone: '123', consent: true } });
    assert.strictEqual(bad.status, 400, 'a short phone number is refused');
    bad = await request(port, 'POST', '/member/' + token, { body: { legalName: 'Pat Doe', personalEmail: 'not-an-email', consent: true } });
    assert.strictEqual(bad.status, 400, 'a bad personal email is refused');
    const stillOpen = await request(port, 'GET', '/member/' + token);
    assert.ok(stillOpen.text.includes('Hello Pat Doe'), 'refused submissions leave the link usable');
    console.log('✓ Refused submissions explain why and leave the link usable');

    // 4. A valid submission saves the four details and uses up the link.
    const ok = await request(port, 'POST', '/member/' + token, { body: {
      legalName: 'Patricia Doe', phone: '(312) 555-0100', personalEmail: 'pat@personal.example', stateEmail: 'patricia.doe@state.example', consent: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    const row = (await pool.query("select * from member_contacts where member_name='Pat Doe'")).rows[0];
    assert.strictEqual(row.legal_name, 'Patricia Doe');
    assert.strictEqual(row.phone, '(312) 555-0100');
    assert.strictEqual(row.personal_email, 'pat@personal.example');
    assert.strictEqual(row.state_email, 'patricia.doe@state.example');
    assert.strictEqual(row.updated_by, 'member');
    assert.strictEqual(row.location, 'NorthSide FCRC', 'the location the steward chose is kept on the record');
    assert.ok(row.consent_at, 'consent time is recorded');
    console.log('✓ A valid submission saves legal name, phone, personal email and state email, with the consent time');

    // 5. The same link cannot be used again.
    const again = await request(port, 'POST', '/member/' + token, { body: { legalName: 'Someone Else', phone: '3125550199', consent: true } });
    assert.strictEqual(again.status, 400, 'a used link is refused');
    assert.strictEqual((await pool.query("select legal_name from member_contacts where member_name='Pat Doe'")).rows[0].legal_name, 'Patricia Doe', 'the second attempt changed nothing');
    const usedPage = await request(port, 'GET', '/member/' + token);
    assert.ok(usedPage.text.includes('Already submitted'));
    console.log('✓ A link works once; a second use changes nothing');

    // 6. A new link for the same member replaces an unused one; an expired link is refused.
    const first = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { memberName: 'Lee Park', location: 'North Suburban FCRC' } });
    const second = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { memberName: 'Lee Park', location: 'North Suburban FCRC' } });
    const firstToken = first.json.url.split('/member/')[1];
    const secondToken = second.json.url.split('/member/')[1];
    assert.strictEqual((await request(port, 'GET', '/member/' + firstToken)).status, 410, 'the earlier unused link stops working');
    assert.strictEqual((await request(port, 'GET', '/member/' + secondToken)).status, 200, 'the newest link works');
    await pool.query("update member_links set expires_at = now() - interval '1 minute' where token_hash = $1", [require('crypto').createHash('sha256').update(secondToken).digest('hex')]);
    assert.strictEqual((await request(port, 'GET', '/member/' + secondToken)).status, 410, 'an expired link is refused');
    assert.strictEqual((await request(port, 'GET', '/member/' + 'a'.repeat(48))).status, 404, 'an unknown link is not found');
    console.log('✓ A newer link replaces an unused one; expired and unknown links are refused');

    // 7. Stewards see the details; a read-only account does not.
    const list = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.strictEqual(list.status, 200);
    const pat = list.json.contacts.find(c => c.memberName === 'Pat Doe');
    assert.ok(pat && pat.legalName === 'Patricia Doe' && pat.stateEmail === 'patricia.doe@state.example' && pat.location === 'NorthSide FCRC', 'a steward sees the details and the location');
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts', { cookie: viewer })).status, 403, 'a read-only account cannot see them');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: viewer, body: { memberName: 'X Y' } })).status, 403, 'a read-only account cannot create links');
    console.log('✓ Stewards see member details; read-only accounts cannot see them or create links');

    // 8. Removing a member's details removes their details and open links.
    const removed = await request(port, 'POST', '/api/member-contacts/remove', { cookie: steward, body: { memberName: 'Pat Doe' } });
    assert.strictEqual(removed.status, 200);
    const after = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.ok(!after.json.contacts.some(c => c.memberName === 'Pat Doe'), 'the details are removed');
    console.log('✓ Removing a member deletes their details');
  } finally {
    server.close();
  }
  console.log('\nALL MEMBER CONTACT TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
