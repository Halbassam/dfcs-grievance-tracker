const assert = require('assert');
const path = require('path');
const http = require('http');

// Request and file handling, checked over real HTTP where it matters:
// - an attachment whose name has non-Latin-1 characters (Word puts en dashes
//   in filenames) must download, not crash the response;
// - a file already removed from storage must still be deletable;
// - a non-numeric audit limit must not fail;
// - an oversized or malformed body gets a clear 413/400 reply;
// - the archive date is the Chicago date, like every other date in the app.

process.env.SUPABASE_URL = 'https://storage.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests';

function request(port, method, pathname, { body, rawBody, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : null);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

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
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));

  // 1. Storage delete: an object already gone counts as deleted; other failures still error.
  {
    const storagePath = path.resolve(__dirname, '..', 'server/storage.js');
    const realStorage = require(storagePath);
    const realFetch = global.fetch;
    try {
      global.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not found' });
      await realStorage.deleteObject('already-gone.pdf');
      global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
      await assert.rejects(realStorage.deleteObject('x.pdf'), /delete failed \(500\)/);
    } finally { global.fetch = realFetch; }
    console.log('✓ Deleting a file already gone from storage succeeds; real storage errors still surface');
  }

  // 2. Chicago archive date.
  {
    assert.strictEqual(db.chicagoDateISO(new Date('2026-11-19T02:30:00Z')), '2026-11-18', 'a UTC evening is still the previous day in Chicago');
    assert.strictEqual(db.chicagoDateISO(new Date('2026-07-04T15:00:00Z')), '2026-07-04');
    console.log('✓ The archive date is the Chicago calendar date');
  }

  // Routes, with storage replaced by an in-memory stand-in.
  const stored = new Map();
  const storageModulePath = path.resolve(__dirname, '..', 'server/storage.js');
  require.cache[storageModulePath] = {
    id: storageModulePath, filename: storageModulePath, loaded: true,
    exports: {
      uploadObject: async (p, buf) => { stored.set(p, buf); },
      downloadObject: async p => stored.get(p),
      deleteObject: async p => { stored.delete(p); }
    }
  };
  await db.upsertUser({ username: 'boss', displayName: 'Boss', password: 'bosspass1' });

  const realCreateServer = http.createServer;
  let server;
  http.createServer = (...a) => { server = realCreateServer.apply(http, a); return server; };
  process.env.PORT = '0';
  delete require.cache[path.resolve(__dirname, '..', 'server/index.js')];
  require(path.resolve(__dirname, '..', 'server/index.js'));
  http.createServer = realCreateServer;
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const loginRes = await request(port, 'POST', '/api/auth/login', { body: { username: 'boss', password: 'bosspass1' } });
  const cookie = /dfcs_session=([^;]+)/.exec(loginRes.headers['set-cookie'][0])[0];

  // 3. A filename with an en dash uploads, downloads, and gets a valid header.
  const name = 'Smith – grievance.pdf';
  const up = await request(port, 'POST', '/api/grievance/attachment', { cookie, body: {
    gid: 'G-9', filename: name, contentType: 'application/pdf',
    dataBase64: Buffer.from('hello world').toString('base64')
  } });
  assert.strictEqual(up.status, 200, 'upload: ' + JSON.stringify(up.json));
  assert.ok(!up.json.storagePath && ![...stored.keys()].some(k => k.includes('/')), 'stored objects use a flat path (no "/")');
  const dl = await request(port, 'GET', '/api/grievance/attachment/' + up.json.id, { cookie });
  assert.strictEqual(dl.status, 200, 'download should work for a non-Latin-1 filename, got ' + dl.status);
  assert.strictEqual(dl.raw, 'hello world');
  assert.ok(dl.headers['content-disposition'].includes("filename*=UTF-8''Smith%20%E2%80%93%20grievance.pdf"), 'header: ' + dl.headers['content-disposition']);
  console.log('✓ An attachment with an en dash in its name uploads and downloads, with a valid header');

  // 4. Deleting an attachment whose stored file is missing still works.
  stored.clear();
  const del = await request(port, 'DELETE', '/api/grievance/attachment/' + up.json.id, { cookie });
  assert.strictEqual(del.status, 200, 'delete: ' + JSON.stringify(del.json));
  console.log('✓ An attachment record is deletable even when its file is already gone');

  // 5. Oversized body: a clear 413, not a dropped connection.
  const big = JSON.stringify({ id: 'G-BIG', employee: 'x'.repeat(1.5 * 1024 * 1024) });
  const tooBig = await request(port, 'POST', '/api/grievance', { cookie, rawBody: big });
  assert.strictEqual(tooBig.status, 413, 'an oversized body should get a 413, got ' + tooBig.status);
  console.log('✓ An oversized request gets a clear 413 reply');

  // 6. Malformed JSON: a clear 400, not silently treated as an empty form.
  const bad = await request(port, 'POST', '/api/grievance', { cookie, rawBody: '{"id": "G-BAD", ' });
  assert.strictEqual(bad.status, 400, 'malformed JSON should get a 400, got ' + bad.status);
  assert.ok(/valid JSON/.test(bad.json.error), bad.json.error);
  console.log('✓ Malformed JSON gets a clear 400 reply');

  // 7. A non-numeric audit limit is fine.
  const audit = await request(port, 'GET', '/api/audit/log?limit=abc', { cookie });
  assert.strictEqual(audit.status, 200, 'limit=abc must not fail, got ' + audit.status);
  assert.ok(Array.isArray(audit.json.rows));
  console.log('✓ A non-numeric audit limit falls back to the default');

  // 8. Path traversal is not served.
  const trav = await request(port, 'GET', '/../package.json');
  assert.ok(!trav.raw.includes('"name": "fcrc-grievance-tracker"'), 'a path outside public/ must never be served');
  console.log('✓ Paths outside the public folder are never served');

  server.close();
  console.log('\nALL REQUEST HARDENING TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
