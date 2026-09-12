# FCRC Grievance Tracker — Update v3.2.0

Update package for an EXISTING deployment (GitHub + Supabase + Render).

## REQUIRED: one SQL step before using the new features

Open the Supabase SQL Editor and run the contents of:

    migrations/003_add_org_settings.sql

(Safe to re-run. It only adds six empty settings keys — no data is touched.)

If your database is still on the version WITHOUT admin/steward roles,
also run `migrations/002_add_roles.sql` first. If the live app already
shows a role dropdown under Manage Users, you already have it.

## Deploying the code

1. Open your GitHub repo (github.com/Halbassam/dfcs-grievance-tracker)
2. Upload ALL files from this zip, replacing the existing ones
   (`package.json`, everything in `server/`, `public/index.html`,
   and the `migrations/` folder). Commit to main.
3. Render redeploys automatically. Wait for "Your service is live".
4. Hard-refresh the app in your browser (Ctrl+Shift+R).

## What's new in this update

- **Deadline emails fixed** — reminders now include the union's own
  Step 2 and Step 3 FILING deadlines (the ones that waive the
  grievance if missed), not just management's response deadlines.
  No reminders after Step 3 is filed — Council 31 staff track Step 4.
- **Intake Form simplified** — Shift, Bureau, Location, and County
  removed. These are now set ONCE in Settings → Local chapter info,
  together with Agency and AFSCME Local No.
- **Page title** shows your local number (e.g. "FCRC Grievance
  Tracker — Local 2858") once set in Settings.
- **Steward Workload** — "By DFCS bureau" removed; location section
  is now "By Local <your number>".
- **Official grievance form printing** — grievance detail → Print
  produces the AFSCME/State of Illinois Contract Grievance form,
  auto-filled from tracker + Settings. Statement of Grievance box,
  Step 2/3/4 dates, and all signature lines stay blank for
  hand-completion. No activity history on the printout.
- **Edit in form fixed** — all step dates now pre-fill when editing.
- **Stewards can change their own password** — Settings → Change my
  password (requires current password).
- **Editable dropdown lists** — Settings → Other dropdown lists.

## After deploying

Log in as an admin → Settings → **Local chapter info** → fill in all
six fields → Save. The printed form and page title use these values.

## Verification

`__selftest__/run_smoke.js` — 14 checks against real executed SQL
(pg-mem) and a real DOM (jsdom). To run locally:
    npm install --no-save pg-mem jsdom
    node __selftest__/run_smoke.js
