/**
 * Frontend logic test — NOT part of the deployed app.
 *
 * Loads the REAL public/index.html into jsdom (a real DOM
 * implementation, no browser binary needed — this sandbox can't
 * download Chrome/Chromium, so this is the most rigorous check
 * available here) and exercises the actual, unmodified renderLog()
 * search filtering and printGrievance() functions with realistic
 * data, asserting on the real HTML they produce.
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

async function main() {
  let html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  // STATE, SETUP, $, etc. are declared with `let`/`const` at the top
  // level of the app's <script> tag. That makes them visible to a
  // LATER <script> tag in the same document (classic scripts share one
  // global lexical scope), but it does NOT put them on `window` --
  // that's true in real browsers too, not just jsdom. So we inject a
  // small bridge script right after the app's own </script> that
  // explicitly exposes the handful of bindings this test needs.
  html = html.replace(
    "</script>",
    `</script>\n<script>
      window.__test_getState = () => STATE;
      window.__test_setState = (s) => { STATE = s; };
      window.__test_setOrgSettings = (o) => { ORG_SETTINGS = o; };
      window.__test_dollar = (id) => $(id);
      window.__test_renderLog = () => renderLog();
      window.__test_printGrievance = (gid) => printGrievance(gid);
    </script>`
  );

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    resources: "usable",
    url: "http://localhost/"
  });
  const { window } = dom;

  // The app's init() IIFE calls checkSession() etc. via fetch, which
  // doesn't exist in this offline test — stub fetch so the script
  // doesn't throw on load. We don't need the app's full boot
  // sequence; we only need its function definitions and STATE object
  // to exist, which happen synchronously when the script parses.
  window.fetch = () => Promise.reject(new Error("fetch disabled in frontend test"));

  // Give the script a moment to finish evaluating (jsdom runs
  // <script> tags synchronously on load, but the trailing init()
  // IIFE kicks off async work we want to let settle/fail quietly).
  await new Promise((resolve) => {
    dom.window.addEventListener("load", () => setTimeout(resolve, 50));
  });

  const w = dom.window;

  // Sanity check: confirm the real functions we're about to test
  // actually exist on the page (i.e. the script parsed and ran).
  assert.strictEqual(typeof w.__test_renderLog, "function", "renderLog bridge should be defined");
  assert.strictEqual(typeof w.__test_printGrievance, "function", "printGrievance bridge should be defined");
  console.log("✓ index.html parsed successfully; renderLog and printGrievance are defined");

  // ---------- Set up realistic STATE data ----------
  w.__test_setState({
    grievances: [
    { id: "2026-001", employee: "Jane Doe", steward: "Hazem Albassam", status: "Pending", jobClass: "Human Services Caseworker (RC-62)", bureau: "Bureau of Family & Community Programs", location: "Roseland (1S)", county: "Cook R1S", gtype: "Workload - Unreasonable / Excessive Caseload (Art. XXXI Sec. 1)", article: "Art. XXXI Sec. 1", section: "", bu: "RC-62 (Professional)", shift: "Day (1st Shift)", stewardEmail: "hazem.albassam@illinois.gov", remedy: "Adjust caseload", step1filed: "2026-06-01" },
    { id: "2026-002", employee: "John Smith", steward: "Maria Perez", status: "Settled", jobClass: "Office Clerk (RC-14)", bureau: "Bureau of Family & Community Programs", location: "Aurora (Kane County)", county: "Kane", gtype: "Holiday Pay - Improper / Denied (Art. XI)", article: "Art. XI", section: "", bu: "RC-14 (Clerical / Office)", shift: "Evening (2nd Shift)", stewardEmail: "maria.p.perez@illinois.gov", remedy: "Back pay", step1filed: "2026-05-01" },
    { id: "2026-003", employee: "Pat Jones", steward: "Hazem Albassam", status: "Pending", jobClass: "Human Services Caseworker (RC-62)", bureau: "Bureau of Family & Community Programs", location: "Joliet (Will County)", county: "Will", gtype: "Sick Leave - Denied (Art. XXIII Sec. 16)", article: "Art. XXIII Sec. 16", section: "", bu: "RC-62 (Professional)", shift: "Day (1st Shift)", stewardEmail: "hazem.albassam@illinois.gov", remedy: "Restore sick time", step1filed: "2026-06-10" }
    ],
    activity: [
      { gid: "2026-001", date: "2026-06-02", type: "Step 1 - Oral Grievance Raised with Supervisor", steward: "Hazem Albassam", notes: "Met with supervisor about caseload numbers." },
      { gid: "2026-001", date: "2026-06-05", type: "Document - Caseload / Workload Records Obtained", steward: "Hazem Albassam", notes: "" }
    ],
    archive: [],
    holidays: []
  });
  // Agency and AFSCME Local No. are now org-wide settings (set once in
  // Settings > Local chapter info), not per-grievance fields -- set
  // separately here, matching how the real app populates ORG_SETTINGS
  // from GET /api/data's orgSettings field.
  w.__test_setOrgSettings({ agency: "DHS", localNo: "2858" });

  // ---------- Test: renderLog with no search query shows all 3 ----------
  w.__test_dollar('logSearchInput').value = '';
  w.__test_renderLog();
  let bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(bodyHtml.includes('2026-001'));
  assert.ok(bodyHtml.includes('2026-002'));
  assert.ok(bodyHtml.includes('2026-003'));
  console.log("✓ renderLog() with empty search shows all grievances");

  // ---------- Test: search by employee name ----------
  w.__test_dollar('logSearchInput').value = 'jane';
  w.__test_renderLog();
  bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(bodyHtml.includes('2026-001'));
  assert.ok(!bodyHtml.includes('2026-002'));
  assert.ok(!bodyHtml.includes('2026-003'));
  console.log("✓ search by employee name (\"jane\") correctly filters to one match, case-insensitive");

  // ---------- Test: search by grievance ID ----------
  w.__test_dollar('logSearchInput').value = '2026-002';
  w.__test_renderLog();
  bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(!bodyHtml.includes('>2026-001<'));
  assert.ok(bodyHtml.includes('2026-002'));
  console.log("✓ search by grievance ID correctly filters to one match");

  // ---------- Test: search by steward name returns multiple matches ----------
  w.__test_dollar('logSearchInput').value = 'Hazem';
  w.__test_renderLog();
  bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(bodyHtml.includes('2026-001'));
  assert.ok(bodyHtml.includes('2026-003'));
  assert.ok(!bodyHtml.includes('2026-002'));
  console.log("✓ search by steward name correctly returns multiple matches (2026-001 and 2026-003)");

  // ---------- Test: search with no matches shows the empty-state message ----------
  w.__test_dollar('logSearchInput').value = 'nonexistent-zzz';
  w.__test_renderLog();
  bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(bodyHtml.includes('No matches'));
  assert.ok(!bodyHtml.includes('2026-001'));
  console.log("✓ search with no matches shows a clear 'No matches' message instead of an empty table");

  // ---------- Test: clearing the search shows everything again ----------
  w.__test_dollar('logSearchInput').value = '';
  w.__test_renderLog();
  bodyHtml = w.__test_dollar('logBody').innerHTML;
  assert.ok(bodyHtml.includes('2026-001') && bodyHtml.includes('2026-002') && bodyHtml.includes('2026-003'));
  console.log("✓ clearing the search box restores the full list");

  // ---------- Test: printGrievance renders the official AFSCME form, auto-filled correctly ----------
  // Stub window.print so calling it doesn't error/hang in this headless test.
  let printWasCalled = false;
  w.print = () => { printWasCalled = true; };

  w.__test_printGrievance('2026-001');
  await new Promise(r => setTimeout(r, 80)); // printGrievance uses a 50ms setTimeout before calling print()

  const printHtml = w.__test_dollar('printArea').innerHTML;
  assert.ok(printHtml.includes('CONTRACT GRIEVANCE'), "print view should show the official form title");
  assert.ok(printHtml.includes('>2026-001<'), "print view should show the grievance ID in the form's number box");
  assert.ok(printHtml.includes('Jane Doe'), "print view should show the employee name");
  assert.ok(printHtml.includes('>DHS<'), "print view should show the Agency field, sourced from ORG_SETTINGS (not the grievance record)");
  assert.ok(printHtml.includes('>2858<'), "print view should show the AFSCME Local No. field, sourced from ORG_SETTINGS");
  assert.ok(printHtml.includes('Human Services Caseworker (RC-62)'), "print view should show the job title");
  assert.ok(printHtml.includes('RC-62 (Professional)'), "print view should show the RC / bargaining unit field as full text");
  assert.ok(printHtml.includes('Roseland (1S)'), "print view should show the facility/office");
  assert.ok(printHtml.includes('2026-06-01'), "print view should show the date raised at Step 1");
  assert.ok(printHtml.includes('STEP 1'), "print view should include the Step 1 section");
  assert.ok(printHtml.includes('STEP 2'), "print view should include the Step 2 section");
  assert.ok(printHtml.includes('STEP 3'), "print view should include the Step 3 section");
  assert.ok(printHtml.includes('STEP 4'), "print view should include the Step 4 section");
  console.log("✓ printGrievance() renders the official AFSCME Contract Grievance form, top section + Step 1 auto-filled");

  // ---------- Test: ORG_SETTINGS, not the grievance record, drives Agency/Local No. ----------
  // Even though this fixture grievance has no agency/localNo fields at all
  // (they were intentionally removed from the Intake Form / grievance
  // record), the printed form still shows the correct values because they
  // now come from the org-wide Settings panel instead. The assertions
  // above (>DHS<, >2858<) already prove this; this section exists just to
  // document the requirement clearly in the test output.
  console.log("✓ Agency/Local No. correctly come from the org-wide setting, not a per-grievance field");

  // ---------- Test: Statement of Grievance box is COMPLETELY blank ----------
  // Per requirements, this box is filled in by hand from a previously
  // hand-signed paper form -- the tracker must never write anything into
  // it, including the article reference or remedy sought.
  assert.ok(!printHtml.includes('Art. XXXI Sec. 1'), "Statement of Grievance box must NOT include the CBA article reference");
  assert.ok(!printHtml.includes('Adjust caseload'), "Statement of Grievance box must NOT include the remedy sought");
  assert.ok(!printHtml.includes('Article/Section violated'), "Statement of Grievance box must NOT include any auto-generated text");
  console.log("✓ printGrievance() leaves the Statement of Grievance box completely blank, as required");

  // ---------- Test: Step 2/3/4 appeal dates are blank, not auto-filled from the tracker ----------
  // step2filed/step3filed/step4filed values exist on real grievance records
  // for internal deadline-tracking purposes, but must never appear on the
  // printed form -- those sections are completed by hand from a prior
  // hand-signed form, not generated by the tracker.
  const step2Section = printHtml.slice(printHtml.indexOf('STEP 2'), printHtml.indexOf('STEP 3'));
  const step3Section = printHtml.slice(printHtml.indexOf('STEP 3'), printHtml.indexOf('STEP 4'));
  const step4Section = printHtml.slice(printHtml.indexOf('STEP 4'));
  assert.ok(!step2Section.includes('2026-0'), "Step 2 section must not show any auto-filled date");
  assert.ok(!step3Section.includes('2026-0'), "Step 3 section must not show any auto-filled date");
  assert.ok(!step4Section.includes('2026-0'), "Step 4 section must not show any auto-filled date");
  console.log("✓ printGrievance() leaves Step 2/3/4 appeal dates blank for hand-completion from a prior signed form");

  // ---------- Test: signature lines are present but blank (no fabricated signatures) ----------
  assert.ok(printHtml.includes('Signature of immediate supervisor'), "print view should include the supervisor signature line label");
  assert.ok(printHtml.includes('Signature of employee or union'), "print view should include the employee/union signature line label");
  // The steward's name should NOT appear pre-filled into any signature line anywhere on the form.
  assert.ok(!printHtml.includes('Hazem Albassam'), "the steward's name must not appear anywhere on the printed form -- no fabricated signatures");
  console.log("✓ printGrievance() leaves all signature lines blank for hand-signing -- no fabricated signatures, no steward name anywhere on the form");

  // ---------- Test: printGrievance does NOT include an activity history section ----------
  // The activity-history section below the form was removed per requirements --
  // the printed page should be the official form only, nothing else.
  assert.ok(!printHtml.includes('Activity history'), "print view must NOT include an activity history section");
  assert.ok(!printHtml.includes('Met with supervisor about caseload numbers'), "print view must NOT include any activity log notes");
  console.log("✓ printGrievance() does not include an activity history section -- the printed page is the official form only");

  // ---------- Test: printGrievance does NOT leak another grievance's data ----------
  assert.ok(!printHtml.includes('John Smith'), "print view for 2026-001 should not show 2026-002's employee");
  console.log("✓ printGrievance() does not leak data from other grievances");

  // ---------- Test: print() was actually invoked ----------
  assert.strictEqual(printWasCalled, true, "window.print() should have been called");
  console.log("✓ window.print() is correctly triggered after the print view is populated");

  console.log("\nAll frontend (search + print) self-tests passed.");
  window.close();
}

main().catch((err) => {
  console.error("\n✗ FRONTEND SELF-TEST FAILED:", err);
  process.exit(1);
});
