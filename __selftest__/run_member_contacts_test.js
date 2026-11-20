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
    create table contact_links (token_hash text primary key, location text not null, created_by text not null default '', created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz);
    create table contact_submissions (id text primary key, location text not null, legal_name text not null default '', phone text not null default '', personal_email text not null default '', state_email text not null default '', consent_at timestamptz not null default now(), submitted_at timestamptz not null default now());
  `);
  await pool.query(`insert into setup_lists (key, items) values ('Location', '["North Suburban FCRC","NorthSide FCRC"]')`);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
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
  const ip = n => ({ 'X-Forwarded-For': `10.0.0.${n}` });

  try {
    const login = async (u, p) => {
      const r = await request(port, 'POST', '/api/auth/login', { body: { username: u, password: p } });
      return /dfcs_session=([^;]+)/.exec(r.headers['set-cookie'][0])[0];
    };
    const steward = await login('steward1', 'stewardpass1');
    const viewer = await login('viewer1', 'viewerpass1');
    const tokenOf = url => url.split('/contact/')[1];

    // 1. A steward creates one link per location. Location is required and must be on the list.
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: {} })).status, 400, 'a location is required');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { location: 'Mars' } })).status, 400, 'location must be on the list');
    const made = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { location: 'NorthSide FCRC' } });
    assert.strictEqual(made.status, 200, JSON.stringify(made.json));
    assert.ok(!('memberName' in made.json), 'the link carries no member name');
    const token = tokenOf(made.json.url);
    assert.ok(/^[a-f0-9]{48}$/.test(token));
    const stored = await pool.query('select token_hash from contact_links');
    assert.ok(stored.rows.every(r => r.token_hash !== token), 'the raw token is never stored');
    console.log('✓ A steward creates a location link; only a hash of the token is stored; no name is attached');

    // 2. The link opens the same form for anyone. It shows the location, not a name, and has a hidden trap field.
    const page = await request(port, 'GET', '/contact/' + token);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Contact details for NorthSide FCRC'));
    assert.ok(!/Hello/.test(page.text), 'the form is not personalised');
    assert.ok(page.text.includes('id="website"'), 'hidden trap field is present');
    console.log('✓ The link opens an unpersonalised form for its location');

    // 3. Refused entries say why and do not use up the link. Every attempt is counted against the limit,
    //    so these use one connection and the valid entries use another.
    const r1 = await request(port, 'POST', '/contact/' + token, { headers: ip(1), body: { legalName: 'Ann Lee', phone: '3125550100', consent: false } });
    assert.strictEqual(r1.status, 400, 'no consent is refused');
    const r2 = await request(port, 'POST', '/contact/' + token, { headers: ip(2), body: { legalName: 'A', phone: '3125550100', consent: true } });
    assert.strictEqual(r2.status, 400, 'a one-letter name is refused');
    const r3 = await request(port, 'POST', '/contact/' + token, { headers: ip(3), body: { legalName: 'Ann Lee', consent: true } });
    assert.strictEqual(r3.status, 400, 'no phone and no email is refused');
    const r4 = await request(port, 'POST', '/contact/' + token, { headers: ip(4), body: { legalName: 'Ann Lee', personalEmail: 'not-an-email', consent: true } });
    assert.strictEqual(r4.status, 400, 'a bad personal email is refused');
    console.log('✓ Refused entries explain why');

    // 4. Several people can use the same link; each entry is kept separately.
    const a = await request(port, 'POST', '/contact/' + token, { headers: ip(5), body: { legalName: 'Ann Lee', phone: '(312) 555-0100', personalEmail: 'ann@personal.example', stateEmail: 'ann.lee@state.example', consent: true } });
    assert.strictEqual(a.status, 200, JSON.stringify(a.json));
    const b = await request(port, 'POST', '/contact/' + token, { headers: ip(6), body: { legalName: 'Ben Ortiz', phone: '3125550199', consent: true } });
    assert.strictEqual(b.status, 200, JSON.stringify(b.json));
    const rows = (await pool.query('select location, legal_name from contact_submissions order by legal_name')).rows;
    assert.deepStrictEqual(rows.map(r => r.legal_name), ['Ann Lee', 'Ben Ortiz'], 'two people, two entries');
    assert.ok(rows.every(r => r.location === 'NorthSide FCRC'), 'entries carry the link location');
    console.log('✓ One link serves many people; each person’s entry is kept separately');

    // 5. A filled-in hidden field is treated as a bot: it reports success and saves nothing.
    const bot = await request(port, 'POST', '/contact/' + token, { headers: ip(7), body: { legalName: 'Bot Name', phone: '3125550123', consent: true, website: 'spam' } });
    assert.strictEqual(bot.status, 200);
    assert.strictEqual((await pool.query("select count(*)::int as n from contact_submissions where legal_name='Bot Name'")).rows[0].n, 0, 'bot entries are not saved');
    console.log('✓ A bot that fills the hidden field gets a success message but nothing is saved');

    // 6. Too many submissions from one connection are refused for a while.
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const r = await request(port, 'POST', '/contact/' + token, { headers: ip(8), body: { legalName: 'Flood Test', phone: '3125550177', consent: true } });
      if (r.status === 429) { limited = r; break; }
    }
    assert.ok(limited, 'repeated submissions from one connection are limited');
    console.log('✓ Repeated submissions from one connection are limited (429)');

    // 7. A new link for the same location replaces the old one.
    const newer = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { location: 'NorthSide FCRC' } });
    const newToken = tokenOf(newer.json.url);
    assert.strictEqual((await request(port, 'GET', '/contact/' + token)).status, 410, 'the old link stops working');
    assert.strictEqual((await request(port, 'GET', '/contact/' + newToken)).status, 200, 'the new link works');
    console.log('✓ A new link for a location replaces the old one');

    // 8. Revoking a link stops it at once; an expired link is refused.
    await request(port, 'POST', '/api/member-contacts/revoke', { cookie: steward, body: { location: 'NorthSide FCRC' } });
    assert.strictEqual((await request(port, 'GET', '/contact/' + newToken)).status, 410, 'a revoked link is refused');
    assert.strictEqual((await request(port, 'POST', '/contact/' + newToken, { headers: ip(9), body: { legalName: 'Late Entry', phone: '3125550111', consent: true } })).status, 400, 'a revoked link cannot submit');
    const third = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { location: 'North Suburban FCRC' } });
    const thirdToken = tokenOf(third.json.url);
    await pool.query("update contact_links set expires_at = now() - interval '1 minute' where token_hash = $1", [crypto.createHash('sha256').update(thirdToken).digest('hex')]);
    assert.strictEqual((await request(port, 'GET', '/contact/' + thirdToken)).status, 410, 'an expired link is refused');
    assert.strictEqual((await request(port, 'GET', '/contact/' + 'a'.repeat(48))).status, 404, 'an unknown link is not found');
    console.log('✓ Revoked and expired links are refused');

    // 9. Stewards see submissions and active links; read-only accounts see nothing.
    const list = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.strictEqual(list.status, 200);
    assert.ok(list.json.submissions.some(s => s.legalName === 'Ben Ortiz'), 'submissions are listed');
    assert.ok(list.json.submissions.some(s => s.legalName === 'Ann Lee' && s.stateEmail === 'ann.lee@state.example'));
    assert.deepStrictEqual(list.json.activeLinks, [], 'revoked and expired links are not listed as active');
    const live = await request(port, 'POST', '/api/member-contacts/link', { cookie: steward, body: { location: 'NorthSide FCRC' } });
    const liveList = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.deepStrictEqual(liveList.json.activeLinks.map(l => l.location), ['NorthSide FCRC'], 'a live link is listed as active');
    await request(port, 'POST', '/api/member-contacts/revoke', { cookie: steward, body: { location: 'NorthSide FCRC' } });
    assert.strictEqual((await request(port, 'GET', '/api/member-contacts', { cookie: viewer })).status, 403, 'a read-only account cannot see them');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/link', { cookie: viewer, body: { location: 'NorthSide FCRC' } })).status, 403, 'a read-only account cannot create links');
    console.log('✓ Stewards see submissions and active links; read-only accounts cannot');

    // 10. Removing one person's entry leaves the others.
    const ann = list.json.submissions.find(s => s.legalName === 'Ann Lee');
    assert.strictEqual((await request(port, 'POST', '/api/member-contacts/remove', { cookie: steward, body: { id: ann.id } })).status, 200);
    const after = await request(port, 'GET', '/api/member-contacts', { cookie: steward });
    assert.ok(!after.json.submissions.some(s => s.legalName === 'Ann Lee'), 'the chosen entry is removed');
    assert.ok(after.json.submissions.some(s => s.legalName === 'Ben Ortiz'), 'other entries are kept');
    console.log('✓ Removing one entry leaves the others');
  } finally {
    server.close();
  }
  console.log('\nALL MEMBER CONTACT TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
