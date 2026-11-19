const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

// The tab bar is now five pages (Grievances, Investigations, Reports, Settings,
// Help) plus a "+ New grievance" button. Checked in the real page:
// - the nav and the default page;
// - switching to pages and to views inside them, including the old names the
//   tour uses;
// - the role rules: who sees new grievance, the drafting view, and the audit log.

(async () => {
  let html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
  html = html.replace('</script>', `</script><script>
    window.__t = {
      switchTab: n => switchTab(n),
      applyRoleVisibility: u => applyRoleVisibility(u),
      page: () => currentPage,
      view: () => currentView
    };
  </script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(window) { window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); } });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));
  const $ = id => w.document.getElementById(id);
  const visible = id => !$(id).classList.contains('hidden') && $(id).style.display !== 'none';
  const tabs = [...w.document.querySelectorAll('nav.tabs .tab-btn')].map(b => b.dataset.tab);

  // 1. The nav: five pages, plus the new-grievance button.
  assert.deepStrictEqual(tabs, ['grievances', 'investigations', 'reports', 'settings', 'help'], 'nav tabs: ' + tabs.join(','));
  assert.ok($('newGrievanceBtn'), 'the + New grievance button must exist');
  console.log('✓ Five pages in the tab bar, plus + New grievance');

  // 2. Default page, and switching to pages and views.
  assert.ok(visible('tab-grievances') && visible('tab-log') && !visible('tab-intake'), 'Grievances, All cases shows first');
  w.__t.switchTab('dashboard');
  assert.ok(visible('tab-grievances') && visible('tab-dashboard') && !visible('tab-log'), 'the Deadlines view shows inside Grievances');
  assert.ok(w.document.querySelector('[data-view="dashboard"]').classList.contains('active'));
  w.__t.switchTab('intake');
  assert.ok(visible('tab-intake') && !visible('tab-grievances'), 'the new grievance form is its own page');
  w.__t.switchTab('draftbot');
  assert.ok(visible('tab-investigations') && visible('tab-draftbot') && !visible('tab-cases'), 'the drafting assistant is a view of Investigations');
  w.__t.switchTab('audit');
  assert.ok(visible('tab-reports') && visible('tab-audit') && !visible('tab-workload'), 'the audit log is a view of Reports');
  w.__t.switchTab('settings');
  assert.ok(visible('tab-settings') && !visible('tab-reports'));
  console.log('✓ Switching to pages and to views works, including the old view names');

  // 3. Role rules.
  w.__t.applyRoleVisibility({ username: 'steve', displayName: 'Steve', role: 'steward', locations: ['L1'] });
  assert.ok(visible('newGrievanceBtn'), 'stewards can file');
  assert.strictEqual(w.document.querySelector('[data-view="draftbot"]').style.display, 'none', 'stewards without the bot do not see the drafting view');
  assert.strictEqual(w.document.querySelector('[data-view="audit"]').style.display, 'none', 'non-admins do not see the audit log');
  w.__t.applyRoleVisibility({ username: 'pat', displayName: 'Pat', role: 'steward_plus', locations: ['L1'] });
  assert.notStrictEqual(w.document.querySelector('[data-view="draftbot"]').style.display, 'none', 'steward plus sees the drafting view');
  console.log('✓ Stewards: + New grievance and no drafting or audit views; steward plus gets the drafting view');

  w.__t.switchTab('intake');
  w.__t.applyRoleVisibility({ username: 'rita', displayName: 'Rita', role: 'read_only', locations: ['L1'] });
  assert.strictEqual($('newGrievanceBtn').style.display, 'none', 'read-only accounts cannot file');
  assert.strictEqual($('investigationsTabBtn').style.display, 'none', 'read-only accounts do not see Investigations');
  assert.strictEqual(w.__t.page(), 'grievances', 'a read-only account on the form is moved to Grievances');
  console.log('✓ Read-only accounts: no + New grievance or Investigations, and are moved off the form');

  console.log('\nALL TAB TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
