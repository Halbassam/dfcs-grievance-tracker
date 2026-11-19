const assert = require('assert');
const path = require('path');

// The public intake link is one-time. The "already submitted?" check and the
// write that marks it used were separate steps, so two submissions at the same
// moment were both accepted and the second overwrote the first. Investigation
// updates were also read-then-write, so a grievant's submission could be
// silently lost to a steward's concurrent logbook entry.

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
    create table app_meta (key text primary key, value text);
    create table investigations (id text primary key, data jsonb not null, created_at timestamptz not null default now());
    create table investigation_tokens (token text primary key, investigation_id text not null, type text not null, witness_name text, created_at timestamptz not null default now(), expires_at timestamptz not null, submitted_at timestamptz);
  `);
  const db = require(path.resolve(__dirname, '..', 'server/db.js'));
  const freshCase = async () => {
    const inv = await db.createInvestigation({ location: 'L1', steward: 'Alice', employee: 'Emp', contactEmail: '', actingUser: 'Alice' });
    const { token } = await db.createInvestigationToken(inv.id, 'grievant');
    return { id: inv.id, token };
  };
  const stored = async id => (await pool.query('select data from investigations where id=$1', [id])).rows[0].data;

  // 1. Two submissions at the same moment: exactly one is accepted and kept.
  {
    const c = await freshCase();
    const results = await Promise.allSettled([
      db.submitInvestigationForm(c.token, { name: 'First Person' }),
      db.submitInvestigationForm(c.token, { name: 'Second Person' })
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, 'exactly one of two simultaneous submissions may be accepted, got ' + ok.length);
    assert.ok(/already been submitted/.test(refused[0].reason.message), 'the other is refused clearly: ' + refused[0].reason.message);
    const winner = results[0].status === 'fulfilled' ? 'First Person' : 'Second Person';
    assert.strictEqual((await stored(c.id)).grievantSubmission.data.name, winner, 'the stored statement must be the accepted one');
    console.log('✓ Two simultaneous submissions: one is accepted and kept, the other is refused');
  }

  // 2. Once a statement is in, the link stays used.
  {
    const c = await freshCase();
    await db.submitInvestigationForm(c.token, { name: 'Original' });
    await assert.rejects(db.submitInvestigationForm(c.token, { name: 'Overwrite' }), /already been submitted/);
    assert.strictEqual((await stored(c.id)).grievantSubmission.data.name, 'Original', 'a later submission must not overwrite the statement');
    console.log('✓ After a statement is saved, the link cannot overwrite it');
  }

  // 3. An expired link is refused.
  {
    const c = await freshCase();
    await pool.query(`update investigation_tokens set expires_at = now() - interval '1 day' where token = $1`, [c.token]);
    await assert.rejects(db.submitInvestigationForm(c.token, { name: 'Late' }), /expired/);
    assert.strictEqual((await stored(c.id)).grievantSubmission, null, 'an expired link must not record anything');
    console.log('✓ An expired link is refused and records nothing');
  }

  // 4. A grievant's submission racing a steward's logbook entry: both survive.
  {
    const c = await freshCase();
    await Promise.all([
      db.submitInvestigationForm(c.token, { name: 'Grievant' }),
      db.addInvestigationLogEntry(c.id, { date: '2026-02-01', steward: 'Alice', entry: 'Called the grievant' })
    ]);
    const inv = await stored(c.id);
    assert.ok(inv.grievantSubmission && inv.grievantSubmission.data.name === 'Grievant', 'the grievant\'s statement must not be lost to the logbook write');
    assert.strictEqual((inv.logbook || []).length, 1, 'the logbook entry must not be lost to the submission');
    console.log('✓ A submission and a logbook entry at the same time both survive');
  }

  console.log('\nALL PUBLIC FORM RACE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
