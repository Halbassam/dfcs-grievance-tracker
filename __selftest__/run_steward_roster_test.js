const assert = require('assert');
const path = require('path');

// The steward roster is two parallel lists: names, and the email at the same
// index. Blank name rows were dropped from the names but not the emails, so
// one blank row shifted every later steward's address onto the wrong person.
// The hand-off and reminder emails look addresses up by that index.

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
  await pool.query(`create table setup_lists (key text primary key, items jsonb not null default '[]');`);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const { findStewardEmail } = require(path.resolve(__dirname, '..', 'server/handoffNotify.js'));
  const lists = async () => ({
    names: await db.getSetupList('Steward'),
    emails: await db.getSetupList('StewardEmail')
  });

  // 1. A blank row in the middle must not move anyone's address.
  await db.updateStewards(['Alice', '', 'Bob', 'Carol'], ['alice@x.gov', '', 'bob@x.gov', 'carol@x.gov']);
  let l = await lists();
  assert.deepStrictEqual(l.names, ['Alice', 'Bob', 'Carol']);
  assert.deepStrictEqual(l.emails, ['alice@x.gov', 'bob@x.gov', 'carol@x.gov'], 'each steward keeps their own address across a blank row, got: ' + JSON.stringify(l.emails));
  console.log('✓ A blank row in the middle does not shift anyone\'s email');

  // 2. The address the hand-off email actually uses is the right one.
  assert.strictEqual(await findStewardEmail({ displayName: 'Bob', username: 'bob' }), 'bob@x.gov', 'Bob must be emailed at his own address');
  assert.strictEqual(await findStewardEmail({ displayName: 'Carol', username: 'carol' }), 'carol@x.gov');
  console.log('✓ Hand-off lookups find each steward\'s own address');

  // 3. A steward with no email stays blank without taking the next steward's address.
  await db.updateStewards(['Dan', 'Erin', ''], ['', 'erin@x.gov', '']);
  l = await lists();
  assert.deepStrictEqual(l.names, ['Dan', 'Erin']);
  assert.deepStrictEqual(l.emails, ['', 'erin@x.gov'], 'a steward without an address must not inherit the next one');
  assert.strictEqual(await findStewardEmail({ displayName: 'Dan', username: 'dan' }), '', 'Dan has no address on file');
  console.log('✓ A steward with no address does not inherit the next steward\'s');

  // 4. Names and emails are trimmed, and a whitespace-only name is treated as blank.
  await db.updateStewards(['  Fay  ', '   ', 'Gus'], [' fay@x.gov ', ' ', 'gus@x.gov']);
  l = await lists();
  assert.deepStrictEqual(l.names, ['Fay', 'Gus']);
  assert.deepStrictEqual(l.emails, ['fay@x.gov', 'gus@x.gov']);
  console.log('✓ Whitespace is trimmed and blank names are dropped with their emails');

  // 5. Mismatched list lengths are still refused.
  await assert.rejects(db.updateStewards(['A', 'B'], ['a@x.gov']), /same length/);
  console.log('✓ Mismatched name and email lists are still refused');

  console.log('\nALL STEWARD ROSTER TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
