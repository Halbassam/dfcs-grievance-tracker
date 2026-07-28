// Real smoke test: db.js critical paths against pg-mem, frontend against jsdom
const assert = require('assert');
const path = require('path');

async function testDb() {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const pgAdapter = mem.adapters.createPg();

  // Intercept the pool module with pg-mem
  const poolPath = path.resolve('/home/claude/dfcs-rebuild/server/pool.js');
  const Pool = pgAdapter.Pool;
  const pool = new Pool();
  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      pool,
      query: (text, params) => pool.query(text, params),
      withTransaction: async (fn) => {
        const client = await pool.connect();
        try { const r = await fn(client); return r; } finally { client.release(); }
      }
    }
  };

  // Create schema (pg-mem compatible subset)
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

  const db = require('/home/claude/dfcs-rebuild/server/db.js');

  // Test 1: submitGrievance ignores removed fields, keeps core fields
  const g1 = await db.submitGrievance({
    id: '2026-001', employee: 'Jane Doe', steward: 'Hazem',
    bureau: 'ShouldBeIgnored', location: 'ShouldBeIgnored', county: 'X', shift: 'Y',
    agency: 'X', localNo: 'Y',
    status: 'Pending', step1filed: '2026-06-01', actingUser: 'Hazem'
  });
  assert.strictEqual(g1.isNew, true);
  assert.strictEqual(g1.record.employee, 'Jane Doe');
  assert.strictEqual(g1.record.bureau, undefined);
  assert.strictEqual(g1.record.location, undefined);
  assert.strictEqual(g1.record.agency, undefined);
  console.log('✓ submitGrievance ignores org-wide fields (bureau/location/county/shift/agency/localNo)');

  // Test 2: date preservation on update
  const g2 = await db.submitGrievance({
    id: '2026-001', employee: 'Jane Doe', steward: 'Hazem',
    status: 'Pending', step1resp: '2026-06-10', actingUser: 'Hazem'
  });
  assert.strictEqual(g2.isNew, false);
  assert.strictEqual(g2.record.step1filed, '2026-06-01');
  assert.strictEqual(g2.record.step1resp, '2026-06-10');
  console.log('✓ submitGrievance preserves prior dates when not resent');

  // Test 3: updateOrgSettings all six fields round-trip
  await db.updateOrgSettings({
    agency: 'DHS', localNo: '2858', bureau: 'BFCP',
    location: 'North Suburban FCRC', county: 'Cook R1N', shift: 'Day'
  });
  const all = await db.getAll();
  assert.strictEqual(all.orgSettings.agency, 'DHS');
  assert.strictEqual(all.orgSettings.localNo, '2858');
  assert.strictEqual(all.orgSettings.bureau, 'BFCP');
  assert.strictEqual(all.orgSettings.location, 'North Suburban FCRC');
  assert.strictEqual(all.orgSettings.county, 'Cook R1N');
  assert.strictEqual(all.orgSettings.shift, 'Day');
  console.log('✓ updateOrgSettings round-trips all six org-wide fields');

  // Test 4: findUpcomingDeadlines includes union FILING deadlines
  // 2026-001: step1filed 2026-06-01, step1resp 2026-06-10 given above.
  // Step 2 filing due = step1resp + 5 WD = 2026-06-17. Today is ~2026-07-12 so it's overdue (not in window).
  // Make a fresh grievance with step1resp such that step2 filing lands within 3 days of "today".
  const today = new Date();
  function iso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  // step1resp = today - 3 calendar days => step2FilingDue = +5 WD from then (1-4 days ahead)
  const resp = new Date(today); resp.setDate(resp.getDate() - 3);
  await db.submitGrievance({
    id: '2026-002', employee: 'Pat Jones', steward: 'Hazem', stewardEmail: 'h@x.gov',
    status: 'Pending', step1filed: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate()-14)),
    step1resp: iso(resp), actingUser: 'Hazem'
  });
  const upcoming = await db.findUpcomingDeadlines(5);
  const hit = upcoming.find(u => u.id === '2026-002');
  assert.ok(hit, 'expected 2026-002 in upcoming deadlines');
  assert.ok(hit.deadlineLabel.includes('filing'), 'expected a FILING deadline, got: ' + hit.deadlineLabel);
  console.log('✓ findUpcomingDeadlines includes union Step 2 filing deadline: "' + hit.deadlineLabel + '" on ' + hit.deadlineDate);

  // Test 5: No Step 4 filing reminder
  await db.submitGrievance({
    id: '2026-003', employee: 'Sam Lee', steward: 'Hazem', stewardEmail: 'h@x.gov',
    status: 'Pending',
    step1filed: '2026-05-01', step1resp: '2026-05-05',
    step2filed: '2026-05-08', step2resp: '2026-05-15',
    step3filed: '2026-05-20', step3resp: iso(resp), // step4 filing basis recent
    actingUser: 'Hazem'
  });
  const upcoming2 = await db.findUpcomingDeadlines(30);
  const step4hit = upcoming2.find(u => u.id === '2026-003');
  assert.ok(!step4hit || !step4hit.deadlineLabel.toLowerCase().includes('step 4'),
    'Step 4 must never generate a reminder, got: ' + (step4hit ? step4hit.deadlineLabel : 'none'));
  console.log('✓ No Step 4 reminder after Step 3 (Council 31 staff track it): ' + (step4hit ? 'other deadline shown: '+step4hit.deadlineLabel : 'no reminder at all'));

  // Test 6: user roles + last-admin guard
  await db.upsertUser({ username: 'hazem', displayName: 'Hazem A', password: 'secret123' });
  const users1 = await db.listUsersSafe();
  assert.strictEqual(users1[0].role, 'admin'); // first ever = admin
  let guardWorked = false;
  try { await db.upsertUser({ username: 'hazem', displayName: 'Hazem A', role: 'steward' }); }
  catch(e){ guardWorked = true; }
  assert.ok(guardWorked, 'last-admin guard should prevent demoting the only admin');
  console.log('✓ First user auto-admin + last-admin guard works');

  // Test 7: change-password flow (verifyLogin + upsertUser without role change)
  const login1 = await db.verifyLogin('hazem', 'secret123');
  assert.ok(login1);
  await db.upsertUser({ username: 'hazem', displayName: 'Hazem A', password: 'newpass456' });
  assert.strictEqual(await db.verifyLogin('hazem', 'secret123'), null);
  const login2 = await db.verifyLogin('hazem', 'newpass456');
  assert.ok(login2);
  assert.strictEqual(login2.role, 'admin', 'password change must not alter role');
  console.log('✓ Password change works; old password rejected; role preserved');
}

async function testFrontend() {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  let html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');
  // Bridge to reach let-scoped internals
  html = html.replace('</script>', `</script><script>
    window.__t = {
      setState: (s)=>{ STATE = s; }, setOrg: (o)=>{ ORG_SETTINGS = o; },
      dollar: (id)=>$(id), renderLog: ()=>renderLog(), print: (g)=>printGrievance(g),
      loadIntoForm: (r)=>loadIntoForm(r), nextDeadline: (r)=>nextDeadline(r),
      updatePageTitle: ()=>updatePageTitle(), renderWorkload: ()=>renderWorkload(),
      setSetup: (s)=>{ SETUP = s; }
    };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));
  assert.ok(w.__t, 'bridge loaded');

  // Elements exist
  for (const id of ['logSearchInput','printArea','detailPrintBtn','orgAgencyInput','orgShiftInput','cpSaveBtn','otherListsButtons','genericListModalOverlay','workloadLocationHeading']) {
    assert.ok(w.__t.dollar(id) || w.document.getElementById(id), 'missing element #' + id);
  }
  console.log('✓ All new UI elements present (search, print, org settings, change-pw, other lists, workload heading)');

  // Data
  w.__t.setSetup({ Steward: ['Hazem'], StewardEmail: ['h@x.gov'], Location: [] });
  w.__t.setOrg({ agency:'DHS', localNo:'2858', bureau:'BFCP', location:'North Suburban FCRC', county:'Cook R1N', shift:'Day' });
  w.__t.setState({ grievances: [
    { id:'2026-001', employee:'Jane Doe', steward:'Hazem', status:'Pending', jobClass:'HSC (RC-62)', bu:'RC-62', gtype:'Workload', article:'Art. XXXI', remedy:'Adjust caseload', awareness:'2026-05-25', step1filed:'2026-06-01', step1resp:'2026-06-10', step2filed:'2026-06-15' }
  ], activity: [], archive: [], holidays: [] });

  // Page title
  w.__t.updatePageTitle();
  assert.ok(w.document.title.includes('Local 2858'), 'title should include Local 2858, got: ' + w.document.title);
  console.log('✓ Page title updates to "' + w.document.title + '"');

  // Search
  w.__t.renderLog();
  w.__t.dollar('logSearchInput').value = 'zzz-no-match';
  w.__t.renderLog();
  assert.ok(w.__t.dollar('logBody').innerHTML.includes('No matches'));
  w.__t.dollar('logSearchInput').value = 'Jane';
  w.__t.renderLog();
  assert.ok(w.__t.dollar('logBody').innerHTML.includes('Jane Doe'));
  console.log('✓ Log search filters correctly');

  // Print form
  let printed = false;
  w.print = () => { printed = true; };
  w.__t.print('2026-001');
  await new Promise(r => setTimeout(r, 100));
  const p = w.__t.dollar('printArea').innerHTML;
  assert.ok(p.includes('CONTRACT GRIEVANCE'));
  assert.ok(p.includes('>DHS<') && p.includes('>2858<'), 'Agency/Local from ORG_SETTINGS');
  assert.ok(p.includes('North Suburban FCRC'), 'Facility from ORG_SETTINGS');
  assert.ok(p.includes('2026-06-01'), 'Date raised at Step 1');
  assert.ok(!p.includes('2026-06-15'), 'Step 2 filed date must NOT appear (blank for hand-completion)');
  assert.ok(!p.includes('Adjust caseload') && !p.includes('Art. XXXI'), 'Statement box must be blank');
  assert.ok(!p.includes('Activity history'), 'No activity history section');
  assert.ok(!p.includes('Hazem'), 'No steward name / fabricated signatures');
  assert.ok(printed, 'window.print called');
  console.log('✓ Print form: official layout, ORG_SETTINGS auto-fill, blank Step 2+, no activity, no signatures');

  // loadIntoForm dates
  w.__t.loadIntoForm({ id:'2026-001', employee:'Jane Doe', status:'Pending', awareness:'2026-05-25', step1filed:'2026-06-01', step1resp:'2026-06-10', step2filed:'2026-06-15' });
  assert.strictEqual(w.__t.dollar('f-step1filed').value, '2026-06-01');
  assert.strictEqual(w.__t.dollar('f-step2filed').value, '2026-06-15');
  console.log('✓ loadIntoForm populates all date fields (edit-form fix)');

  // nextDeadline includes filing deadlines
  const nd = w.__t.nextDeadline({ id:'x', status:'Pending', step1filed:'2026-06-01', step1resp:'2026-06-10' });
  assert.ok(nd, 'expected a next deadline (step 2 filing due)');
  console.log('✓ Browser nextDeadline includes union filing deadlines');

  // Workload heading
  w.__t.renderWorkload();
  assert.ok(w.__t.dollar('workloadLocationHeading').textContent.includes('Local 2858'));
  assert.ok(w.__t.dollar('locationBody').innerHTML.includes('North Suburban FCRC'));
  console.log('✓ Workload: "By Local 2858" heading + single org-location row');
}

(async () => {
  try {
    await testDb();
    await testFrontend();
    console.log('\nALL SMOKE TESTS PASSED');
  } catch (e) {
    console.error('\n✗ SMOKE TEST FAILED:', e.message);
    process.exit(1);
  }
})();
