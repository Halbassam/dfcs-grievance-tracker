# FCRC Grievance Tracker

AFSCME Council 31 — Division of Family & Community Services, IDHS
Master Contract 2023–2027 | Art. V Grievance Procedure

A shared, web-based grievance tracking system for stewards. No Excel,
no macros, no spreadsheet — a real website with a shared live database
that every steward can use at the same time from any device.

Data is stored in a real Postgres database (Supabase), not a file on
disk — see **"How data is stored"** near the bottom for details on
why this matters.

---

## What this version includes

This is the complete, current build of the tracker:

- **Shared live database** (Supabase Postgres) — every steward sees
  the same data instantly, no file-locking, no "who has the latest
  version" confusion
- **Individual logins with Admin / Steward roles** — every steward
  signs in with their own username and password; admins can also
  manage accounts and shared configuration (holiday calendar,
  dropdown lists, steward roster); stewards have full access to all
  grievance and activity work
- **One-file database setup** — a single SQL file creates every
  table *and* pre-populates every dropdown list (Status, Bureau,
  Location, County, Bargaining Unit, Job Classification, Shift,
  every CBA Article, every Grievance Type, every Activity Type, a
  starting Steward roster) plus the 2024–2027 holiday calendar — no
  empty dropdowns on first load
- **Full Art. V deadline tracking** — automatic working-day deadline
  calculations for every grievance step, holiday-aware
- **Daily email reminders** — automatic Gmail-based emails to
  stewards for deadlines coming up within 3 days
- **Search** — instantly filter the Grievance Log by employee name,
  grievance ID, or steward
- **Print / Save as PDF** — a clean, one-page summary of any single
  grievance, ready for a Step 3 meeting or a paper file
- **Archiving** — closed-out grievances (Settled, Denied, Withdrawn,
  Granted, Partially Granted) move to a separate archive on demand

---

## What's in this repo

```
fcrc-grievance-tracker/
├── package.json              (one dependency: pg, the Postgres driver)
├── server/
│   ├── index.js               (the web server and API routes)
│   ├── db.js                  (the database layer — talks to Postgres)
│   ├── pool.js                (the Postgres connection pool)
│   ├── scheduler.js           (daily deadline email checker)
│   ├── mailer.js               (sends email via Gmail SMTP)
│   └── passwords.js            (password hashing)
├── migrations/
│   ├── 001_init.sql            (THE ONLY FILE YOU NEED to run for a
│   │                            brand-new install — creates every
│   │                            table AND pre-populates every
│   │                            dropdown list and the holiday calendar)
│   ├── 002_add_roles.sql       (only needed if upgrading a database that
│   │                            was set up before Admin/Steward roles
│   │                            existed — see "Upgrading an existing
│   │                            database" below)
│   ├── seed_defaults.js        (re-seeds the same defaults from 001_init.sql
│   │                            — only useful if you ever wiped a list back
│   │                            to empty and want the defaults back; a
│   │                            brand-new install doesn't need to run this,
│   │                            001_init.sql already includes it)
│   └── migrate_from_json.js    (only needed if you're upgrading from the
│                                old JSON-file version and want to bring
│                                your existing grievances/holidays/lists over)
└── public/
    └── index.html              (the entire frontend)
```

There is nothing to install beyond one small package (`pg`, the
official Postgres driver) — `npm install` finishes in a few seconds.

---

## Setting up the tracker for the first time

Do these steps in order. It looks like a lot, but each step is short.

### Step 1 — Push this code to GitHub

1. Go to [github.com](https://github.com) and create a **New repository**.
   Name it `fcrc-grievance-tracker` (or anything you like). Public or Private both work.
2. On the new repo's page, click **uploading an existing file**.
3. Drag in all the files and folders from this project
   (`package.json`, the `server` folder, the `public` folder,
   the `migrations` folder, `.gitignore`).
4. Scroll down, click **Commit changes**.

### Step 2 — Create your Supabase database

This is the live database that will hold every grievance, activity
log entry, login account, and dropdown list. It only needs to be set
up once.

1. Go to [supabase.com](https://supabase.com) and create a project.
2. Save the database password you set during project creation — you'll
   need it for the connection string below. **A safety note:** if you
   ever paste a connection string with a real password into a chat,
   AI tool, or anywhere else outside Render's environment variables,
   treat that password as compromised and reset it from
   **Project Settings → Database → Reset database password**.
3. Once the project is ready, open the **SQL Editor**.
4. Open `migrations/001_init.sql` from this repo, copy its **entire
   contents**, paste into the SQL Editor, and click **Run**.

That single file creates every table the app needs *and* fills in
every dropdown list with working defaults — Status, Bureau, every
CBA Article, every Grievance Type, every Activity Type, Bargaining
Unit, Job Classification, Shift, and a starting set of FCRC/work
**locations** and a **steward roster** (with placeholder names and
@illinois.gov-style emails) — plus the full 2024–2027 holiday
calendar. **Nothing will be empty when you open the app.**

The steward roster and location list it seeds are realistic starting
defaults, not necessarily an exact match for your local — review and
edit them once you're logged in (Steward Workload → Manage stewards,
and Settings → Edit locations) to make sure the names, emails, and
office list match your actual local.

It's safe to re-run this file any time — every statement uses
`create table if not exists` or `on conflict do nothing`, so running
it again never duplicates data or overwrites anything you've already
customized.

**If you're upgrading a database that already existed before this
version** (i.e. you already ran an older `001_init.sql` against this
Supabase project), see **"Upgrading an existing database"** below
instead of starting over here.

### Step 3 — Get your Supabase connection string

1. In Supabase: **Project Settings → Database → Connection string**
   (or click the **Connect** button on the main dashboard page if you
   don't see this in Settings).
2. Choose **Connection pooling** (sometimes labeled "Shared Pooler") —
   not "Direct connection." Pick **Transaction** mode if asked. It
   looks like:
   ```
   postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:6543/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with your actual database password.
4. Keep this somewhere safe for the next step — you'll paste it into
   Render's environment variables, **never into a file in this repo,
   and never into a chat conversation**.

### Step 4 — Create the Render account and deploy

1. Go to [render.com](https://render.com) and click **Get Started**.
2. Sign up using your GitHub account (this makes the next part automatic).
3. From the Render dashboard, click **New** → **Web Service**.
4. Find and select your `fcrc-grievance-tracker` repository.
5. Render will detect it automatically. Fill in:
   - **Name**: `fcrc-grievance-tracker` (or anything you like — this becomes part of your URL)
   - **Region**: choose the one closest to Illinois (US East/Ohio is usually closest)
   - **Branch**: `main`
   - **Build Command**: leave as `npm install` (finishes in a few seconds — there's one small dependency)
   - **Start Command**: `npm start`
   - **Instance Type**: select **Free**
6. Before clicking Create, scroll to **Environment Variables** and add:
   - **Key**: `DATABASE_URL` → **Value**: your Supabase pooled connection
     string from Step 3 above (with your real password filled in)
7. Click **Create Web Service**.
8. Wait 1–2 minutes while Render builds and deploys.
9. When it shows "Live" at the top, your URL is shown right below the
   service name — something like:
   `https://fcrc-grievance-tracker.onrender.com`

**That URL is what you give to every steward.** Everyone opens the
same link and sees the same shared, live data.

---

### Step 5 — Set up individual user accounts (login)

Each steward signs in with their own username and password — there's
no shared password to hand out. Every account is either an **Admin**
or a **Steward**:

- **Admin** — full access, plus can manage user accounts, the
  holiday calendar, dropdown lists (Articles, Grievance Types,
  Locations, etc.), and the steward roster.
- **Steward** — full access to grievances, activity logging, the
  dashboard, search, printing, and archiving — everything needed for
  day-to-day case work. Cannot manage user accounts or edit the
  shared configuration lists; those buttons simply don't appear in
  their Settings tab.

**The first time you open the app**, there are no accounts yet, so it
loads with no login screen at all. Go straight to:

1. Click the **Settings** tab.
2. Under **User accounts**, click **Manage users**.
3. Fill in a username, full name, and password for yourself (or whoever
   is setting this up).
4. Click **Save changes**.

**The very first account created is automatically made an Admin** —
there's no one else yet to grant that, so the app does it for you.
The moment that first account is saved, the app immediately requires
everyone — including you — to sign in. You'll see a login screen
appear right away; sign in with the account you just created.

**To add the rest of your stewards**, while logged in as an admin:

1. Settings → **Manage users**
2. Click **+ Add another user** for each steward
3. Fill in their username, display name, a role (**Steward** is the
   default — only change it to **Admin** if this person should also
   be able to manage accounts and shared settings), and a password
   you've chosen for them
4. Click **Save changes**

Give each steward their username and password directly (text, email,
in person — whatever's convenient). They can't reset their own
password from inside the app; if someone forgets theirs, an admin
edits their row in **Manage users**, types a new password into their
existing row, and saves — leaving the password field blank on an
existing user keeps their current password unchanged.

**To remove someone** (they've left the local, etc.), click the **✕**
next to their row in Manage Users and confirm. This does not delete
any grievances they previously worked on — those records stay exactly
as they are, just with their name preserved in the "entered by" history.

**The app always keeps at least one admin.** If you try to demote or
delete the only remaining admin account, it will refuse and tell you
to promote someone else first — this prevents a local from
accidentally locking everyone out of user management entirely.

Every grievance and activity log entry records who created and last
updated it, visible in the grievance detail view.

---

### Step 6 — Set up automatic deadline email reminders (optional)

The app can email each steward a daily summary of any grievance
deadlines coming up within 3 days. This uses your Gmail account to
send the emails.

1. Turn on 2-Step Verification on the Gmail account you want to send
   from: [myaccount.google.com/security](https://myaccount.google.com/security)
2. Create an App Password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   — name it "FCRC Tracker" and copy the 16-character password it gives you.
3. On Render: Dashboard → your service → **Environment** → **Add Environment Variable**, twice:
   - **Key**: `GMAIL_USER` → **Value**: your Gmail address
   - **Key**: `GMAIL_APP_PASSWORD` → **Value**: the 16-character App Password
4. Save — Render redeploys automatically.

Once both variables are set, the **Settings** tab inside the app will
show "Configured," and a daily automatic check begins running. You
can also click **Run deadline check now** any time to trigger it
manually, and **View recent runs** to see a log of what was sent.

**Important about timing**: Render's free tier sleeps after 15 minutes
of no traffic. The daily check runs once per calendar day the app is
awake — it is not tied to a specific clock time. If the app has been
asleep, the check runs the moment it next wakes up and someone visits.
For a guaranteed fixed time every day, you'd need Render's paid tier
(no sleep) or an external "keep awake" ping service.

---

## Upgrading an existing database

If you already had this tracker running on Supabase **before** this
version, you don't need to start over. What you need depends on what
you already have:

**If your database already has Admin/Steward roles** (you ran a
previous version's `002_add_roles.sql`, or set up the database after
roles were introduced): you're already current. Just deploy the new
code (Steps 1 and 4 above) — no SQL changes needed. Your existing
data, accounts, and dropdown lists are untouched.

**If your database predates Admin/Steward roles entirely**: run
`migrations/002_add_roles.sql` once in the Supabase SQL Editor, the
same way you'd run any other SQL file here. This adds the role column
without touching any existing data. Every existing account defaults
to **Steward** afterward — promote one account to Admin directly in
the SQL Editor:
```sql
update users set role = 'admin' where username = 'your-username';
```
(There's no other way to do this first promotion, since no admin
exists yet to do it from inside the app.)

**If any of your dropdown lists are still empty** (Status, Bureau,
Article, Grievance Type, etc. show no options on the Intake Form):
run `migrations/seed_defaults.js` once from your own computer:
```
DATABASE_URL="your connection string" npm run seed
```
This never overwrites a list that already has anything in it, so
it's always safe to run.

---

## Managing user accounts, stewards, FCRC locations, and holidays

No code edits or Render shell access needed for any of this — it's
all done from inside the running app itself (Admin accounts only —
see Step 5 above for the difference between Admin and Steward):

- **Settings tab** → **Manage users** — add, edit, or remove login
  accounts. Each steward should have their own.
- **Settings tab** → **Local chapter info** — set your Agency and
  AFSCME Local No., used to auto-fill the printed grievance form for
  every case.
- **Steward Workload tab** → **Manage stewards** — add, rename, or
  remove stewards and their email addresses.
- **Settings tab** → **Edit locations** — add, rename, or remove
  FCRC / work locations shown on the Intake Form.
- **Settings tab** → **Other dropdown lists** — add, rename, or
  remove entries in any of the other Intake Form dropdowns: Status,
  Bureau / program unit, County, Bargaining unit, Job classification,
  Shift, CBA article violated, and Grievance type. Click **Edit**
  next to whichever list needs a change.
- **Settings tab** → **Edit holidays** — add, remove, or adjust
  observed holiday dates. These are excluded from every working-day
  deadline calculation under Art. V Sec. 2, so keep this list current
  each year.

Removing a steward, location, or any other dropdown entry does
**not** delete any existing grievance records that reference it — it
only removes the option from the dropdown for future entries.

**Note**: a login account (Settings → Manage users) and a steward name
(Steward Workload → Manage stewards) are two separate things. The
login account is who's signed into the website right now. The steward
name on a grievance is who that specific case is assigned to. They're
often the same person, but don't have to be — for example, someone
covering for another steward can log in with their own account and
still assign a grievance to the absent steward's name.

---

## Searching and printing grievances

**Search** — the **Grievance Log** tab has a search box above the
table. Type any part of an employee's name, a grievance ID, or a
steward's name, and the list filters instantly as you type. Clear
the box to see the full list again. This searches every grievance
ever filed (not just active ones), so it's the fastest way to find
an old case.

**Print a single grievance** — open any grievance's detail view
(click its ID from the Log, Dashboard, or anywhere else it's linked)
and click **Print**. This opens a faithful replica of the official
**AFSCME / State of Illinois Contract Grievance** form, with the
employee name, agency, AFSCME local number, job title,
RC/bargaining unit, facility, and the date raised at Step 1
auto-filled — with all the normal app navigation hidden.

Everything from the **Step 2 Statement of Grievance box onward is
intentionally left blank** — that section, the Step 2/3/4 appeal
dates, and every signature line are meant to be completed by hand
from a previously hand-signed paper form, so the tracker never
writes anything into them. The printed page is the official form
only — no activity history or other tracker-generated content is
added below it. Ready to print or use your browser's "Save as PDF"
option — handy before a Step 3 meeting or when a case needs to go
into a paper file.

**Agency and AFSCME Local No.** are set once for your whole local, not
per grievance — see **Settings → Local chapter info** below. Every
printed grievance form automatically uses these same two values.

---

## Setting your Agency and AFSCME Local No.

Before printing your first grievance form, set these once (Admin
accounts only):

1. **Settings tab** → find the **Local chapter info** panel near the
   top.
2. Enter your **Agency** (e.g. "DHS") and **AFSCME Local No.** (e.g.
   "2858").
3. Click **Save**.

These two values are used for every grievance your local prints —
there's no per-case field for them on the Intake Form. If your local
ever needs to change either value, just update it here; every
grievance printed afterward uses the new value automatically.

---

## A note on the free tier

Render's free web services "sleep" after 15 minutes with no traffic.
The first person to open the link after a quiet period will wait
about 20–30 seconds while it wakes up — after that, it's instant for
everyone until it goes quiet again. For a tool used by a handful of
stewards a few times a day, this is barely noticeable.

If this becomes a problem later, Render's paid tier ($7/month) removes
the sleep behavior entirely — but most locals never need this.

Supabase's own free tier is separate from Render's, and has its own
small limits (mainly: a free-tier project pauses after a week of no
API requests, and you'd need to manually un-pause it from the Supabase
dashboard). For a tool used regularly, this is unlikely to come up —
but if your local goes quiet for a stretch (holidays, etc.), check the
Supabase dashboard if the app stops responding.

---

## How data is stored

All grievances, activity log entries, archived records, login
accounts, and dropdown lists are stored in a real Postgres database
hosted by Supabase — **not** a file inside the running Render
service. This solves the exact risk the old file-based version had:
Render's free tier never guarantees its disk survives a service move,
but a Supabase database is a separate, persistent service that
doesn't depend on Render's disk at all. Restarting, redeploying, or
even recreating the Render service from scratch will not lose any
data — as long as `DATABASE_URL` keeps pointing at the same Supabase
project.

**You should still back up your data periodically** — no database is
immune to a mistaken bulk delete or a Supabase-side incident. The
easiest way is to visit `https://your-app-url.onrender.com/api/data`
in a browser every so often and save the page (Ctrl+S) as a JSON
backup. Supabase also offers built-in automatic backups on its paid
plans, and lets you export a full database dump at any time from
**Project Settings → Database → Backups**.

If you ever need to point the app at a different Supabase project
(e.g. moving to a paid Supabase tier, or recovering into a new
project), just update the `DATABASE_URL` environment variable on
Render — nothing else about the app needs to change.

---

## Updating the app later

Any time you want to change something:
1. Edit the file on GitHub directly (click the pencil icon on any file), or
2. Upload a replacement file the same way you did in Step 1.
3. Render automatically redeploys within about a minute of any GitHub change.

If a future update ever adds new database tables or columns, it will
come with its own `migrations/00X_something.sql` file — just run that
new file in the Supabase SQL Editor the same way you ran
`001_init.sql`, before (or right after) deploying the updated code.

---

## Troubleshooting

**Dropdowns are empty on the Intake Form right after deploying** —
hard-refresh your browser (Ctrl+Shift+R or Ctrl+F5). The data is
probably already there; browsers sometimes cache an old copy of the
page from before the database had data in it.

**"FATAL: DATABASE_URL environment variable is not set" in Render
logs** — the environment variable didn't save before the first
deploy ran. Re-check Render → your service → Environment, confirm
`DATABASE_URL` is listed, then trigger a manual redeploy (Render →
your service → Manual Deploy → Deploy latest commit).

**`npm` or `node` not recognized in PowerShell (Windows)** — Node.js
isn't installed, or wasn't added to your PATH. Install it from
[nodejs.org](https://nodejs.org) (the LTS version), then close and
reopen PowerShell completely before trying again.

**"running scripts is disabled on this system" in PowerShell** — run
this once: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
(type `Y` to confirm). This is a standard, safe fix specific to
Windows PowerShell's default security setting.

**A query in Supabase's SQL Editor warns about Row Level Security**
— safe to ignore and run anyway. That warning is about apps that
connect to Supabase directly from a browser using a public key. This
app's Node.js server is the only thing that ever talks to the
database, using the full database connection string, so Row Level
Security doesn't add any protection here.

---

## Support

For questions about this tracker, contact your AFSCME Council 31 staff
representative.
