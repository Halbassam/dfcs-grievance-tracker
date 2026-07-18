const assert = require('assert');
const path = require('path');

async function testBackendPersistence() {
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
  `);
  const db = require(dbPath);

  // Description persists correctly on creation
  const g1 = await db.submitGrievance({
    id: '2026-d1', employee: 'Jane Doe', steward: 'Hazem', status: 'Pending',
    description: 'Supervisor changed my shift with no notice, violates Art. V Sec. 4.',
    actingUser: 'Hazem'
  });
  assert.strictEqual(g1.record.description, 'Supervisor changed my shift with no notice, violates Art. V Sec. 4.');
  console.log('✓ description persists correctly on grievance creation');

  // Blank description is fine (optional field)
  const g2 = await db.submitGrievance({
    id: '2026-d2', employee: 'No Description Case', steward: 'Hazem', status: 'Pending', actingUser: 'Hazem'
  });
  assert.strictEqual(g2.record.description, '', 'description should default to empty string, not undefined, when not provided');
  console.log('✓ description is correctly optional -- defaults to empty string, does not break submission');

  // Description can be added later on an edit
  const g3 = await db.submitGrievance({
    id: '2026-d2', employee: 'No Description Case', steward: 'Hazem', status: 'Pending',
    description: 'Added on a later edit.', actingUser: 'Hazem'
  });
  assert.strictEqual(g3.record.description, 'Added on a later edit.');
  console.log('✓ description can be added on a later edit, not just at creation time');
}

async function testFrontend() {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  let html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__t4 = {
      setState: (s)=>{ STATE = s; }, dollar: (id)=>$(id), renderLog: ()=>renderLog(),
      loadIntoForm: (r)=>loadIntoForm(r), openDetail: (gid)=>openDetail(gid)
    };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));

  // Description field exists on the Intake Form
  assert.ok(w.__t4.dollar('f-description'), 'f-description textarea must exist on the Intake Form');
  console.log('✓ Brief description field exists on the Intake Form');

  // loadIntoForm populates it correctly
  w.__t4.loadIntoForm({ id: '2026-d1', employee: 'Jane Doe', status: 'Pending', description: 'Test description text.' });
  assert.strictEqual(w.__t4.dollar('f-description').value, 'Test description text.');
  console.log('✓ loadIntoForm correctly populates the description field when editing an existing grievance');

  // Log search matches on description content
  w.__t4.setState({
    grievances: [
      { id: '2026-d1', employee: 'Jane Doe', steward: 'Hazem', status: 'Pending', description: 'Shift changed without notice' },
      { id: '2026-d2', employee: 'John Smith', steward: 'Maria', status: 'Pending', description: 'Denied sick leave request' }
    ],
    activity: [], archive: [], holidays: []
  });
  w.__t4.dollar('logSearchInput').value = 'sick leave';
  w.__t4.renderLog();
  const logHtml = w.__t4.dollar('logBody').innerHTML;
  assert.ok(logHtml.includes('John Smith'), 'search by description text should find the matching grievance');
  assert.ok(!logHtml.includes('Jane Doe'), 'search by description text should NOT match unrelated grievances');
  console.log('✓ Grievance Log search correctly matches on description content, not just employee/ID/steward');

  // Detail view shows the description when present, and omits it cleanly when blank
  w.__t4.openDetail('2026-d1');
  const detailHtml1 = w.__t4.dollar('detailBody').innerHTML;
  assert.ok(detailHtml1.includes('Shift changed without notice'), 'detail view should show the description when present');
  console.log('✓ Detail view shows the description prominently when present');

  w.__t4.setState({
    grievances: [{ id: '2026-d3', employee: 'No Desc', steward: 'Hazem', status: 'Pending', description: '' }],
    activity: [], archive: [], holidays: []
  });
  w.__t4.openDetail('2026-d3');
  const detailHtml2 = w.__t4.dollar('detailBody').innerHTML;
  // No stray empty <p></p> block or "—" placeholder clutter for the optional field
  assert.ok(!/background:var\(--paper-2\)[^>]*>\s*<\/p>/.test(detailHtml2), 'blank description should not leave an empty styled block in the detail view');
  console.log('✓ Detail view cleanly omits the description block entirely when there is none (no empty clutter)');
}

(async () => {
  try {
    await testBackendPersistence();
    await testFrontend();
    console.log('\nALL DESCRIPTION FIELD TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
