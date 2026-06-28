# DFCS Grievance Tracker

AFSCME Council 31 — Division of Family & Community Services, IDHS
Master Contract 2023–2027 | Art. V Grievance Procedure

A shared, web-based grievance tracking system for stewards. No Excel,
no macros, no spreadsheet — a real website with a shared live database
that every steward can use at the same time from any device.

Data is stored in a real Postgres database (Supabase), not a file on
disk — see **"How data is stored"** near the bottom for details on
why this matters.

---

## What's in this repo

```
dfcs-tracker/
├── package.json              (one dependency: pg, the Postgres driver)
├── server/
│   ├── index.js               (the web server — unchanged from before)
│   ├── db.js                  (the database layer — talks to Postgres)
│   ├── pool.js                (the Postgres connection pool)
│   ├── scheduler.js           (daily deadline email checker — unchanged)
│   ├── mailer.js               (sends email via Gmail SMTP — unchanged)
│   └── passwords.js            (password hashing — unchanged)
├── migrations/
│   ├── 001_init.sql            (run this once to create the database tables)
│   ├── seed_defaults.js        (run this once on a brand-new database to
│   │                            populate the default Article list, holiday
│   │                            calendar, etc. — skip if you used migrate_from_json.js)
│   └── migrate_from_json.js    (run this once if you're upgrading from the
│                                old JSON-file version and want to bring your
│                                existing grievances/holidays/lists over)
└── public/
    └── index.html              (the entire frontend — unchanged from before)
```

There is nothing to install beyond one small package (`pg`, the
official Postgres driver) — `npm install` finishes in a few seconds.

---

## Setting up the tracker for the first time

Do these steps in order. It looks like a lot, but each step is short.

### Step 1 — Push this code to GitHub

1. Go to [github.com](https://github.com) and create a **New repository**.
   Name it `dfcs-grievance-tracker`. Keep it Public or Private, either works.
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
4. Open `migrations/001_init.sql` from this repo, copy its contents,
   paste into the SQL Editor, and click **Run**.
   This creates all the tables the app needs. It's safe to re-run —
   every statement uses `create table if not exists`.
5. **If you already set up this database before admin/steward roles
   existed**, also run `migrations/002_add_roles.sql` the same way.
   (Brand new databases don't need this — `001_init.sql` already
   includes it.) Existing accounts default to Steward after this
   runs; see Step 6 below for how to promote one to Admin.

### Step 3 — Get your Supabase connection string

1. In Supabase: **Project Settings → Database → Connection string**.
2. Choose the **Connection pooling** tab (not "Direct connection") —
   pick the **Transaction** mode string. It looks like:
   ```
   postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:6543/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with your actual database password.
4. Keep this somewhere safe for the next two steps — you'll paste it
   into Render's environment variables, **never into a file in this
   repo**.

### Step 4 — Populate your data

Pick ONE of the following, not both. Both commands are safe to run
from your own computer (with [Node.js](https://nodejs.org) installed)
— they only need network access to Supabase, not to Render.

**If you're upgrading from the old JSON-file version** and have an
existing `tracker.json` backup (e.g. from visiting `/api/data` on the
old deployment and saving the page):
```
DATABASE_URL="your connection string from Step 3" npm run migrate -- path/to/tracker.json
```
This brings over your grievances, activity history, archive, holiday
calendar, and dropdown lists (Articles, Grievance Types, Stewards,
etc.) exactly as they were. **Login accounts are intentionally NOT
carried over** — everyone (including you) creates their account
again from Settings → Manage users the first time they use the new
version, the same as a brand-new install (see Step 6 below).

**If this is a brand-new install** with no prior data:
```
DATABASE_URL="your connection string from Step 3" npm run seed
```
This populates the default Article list, Grievance Type list,
Steward roster placeholders, and the 2024–2027 holiday calendar —
the same starting defaults the old JSON-file version shipped with.
You can edit any of these later from the Settings tab.

### Step 5 — Create the Render account and deploy

1. Go to [render.com](https://render.com) and click **Get Started**.
2. Sign up using your GitHub account (this makes the next part automatic).
3. From the Render dashboard, click **New** → **Web Service**.
4. Find and select your `dfcs-grievance-tracker` repository.
5. Render will detect it automatically. Fill in:
   - **Name**: `dfcs-grievance-tracker` (or anything you like — this becomes part of your URL)
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
   `https://dfcs-grievance-tracker.onrender.com`

**That URL is what you give to every steward.** Everyone opens the
same link and sees the same shared, live data.

---

### Step 6 — Set up individual user accounts (login)

Each steward signs in with their own username and password — there's
no shared password to hand out anymore. Every account is either an
**Admin** or a **Steward**:

- **Admin** — full access, plus can manage user accounts, the
  holiday calendar, dropdown lists (Articles, Grievance Types,
  Locations, etc.), and the steward roster.
- **Steward** — full access to grievances, activity logging, the
  dashboard, and archiving — everything needed for day-to-day case
  work. Cannot manage user accounts or edit the shared
  configuration lists; those buttons simply don't appear in their
  Settings tab.

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

Every grievance and activity log entry now records who created and
last updated it, visible in the grievance detail view.

---

### Step 7 — Set up automatic deadline email reminders (optional)

The app can email each steward a daily summary of any grievance
deadlines coming up within 3 days. This uses your Gmail account to
send the emails.

1. Turn on 2-Step Verification on the Gmail account you want to send
   from: [myaccount.google.com/security](https://myaccount.google.com/security)
2. Create an App Password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   — name it "DFCS Tracker" and copy the 16-character password it gives you.
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

## Managing user accounts, stewards, FCRC locations, and holidays

No code edits or Render shell access needed for any of this — it's
all done from inside the running app itself:

- **Settings tab** → **Manage users** — add, edit, or remove login
  accounts. Each steward should have their own.
- **Steward Workload tab** → **Manage stewards** — add, rename, or
  remove stewards and their email addresses.
- **Settings tab** → **Edit locations** — add, rename, or remove
  FCRC / work locations shown on the Intake Form.
- **Settings tab** → **Edit holidays** — add, remove, or adjust
  observed holiday dates. These are excluded from every working-day
  deadline calculation under Art. V Sec. 2, so keep this list current
  each year.

Removing a steward or location does **not** delete any existing
grievance records that reference it — it only removes the option
from the dropdown for future entries.

**Note**: a login account (Settings → Manage users) and a steward name
(Steward Workload → Manage stewards) are two separate things. The
login account is who's signed into the website right now. The steward
name on a grievance is who that specific case is assigned to. They're
often the same person, but don't have to be — for example, someone
covering for another steward can log in with their own account and
still assign a grievance to the absent steward's name.

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
service. This solves the exact risk the old version had: Render's
free tier never guarantees its disk survives a service move, but a
Supabase database is a separate, persistent service that doesn't
depend on Render's disk at all. Restarting, redeploying, or even
recreating the Render service from scratch will not lose any data —
as long as `DATABASE_URL` keeps pointing at the same Supabase project.

**You should still back up your data periodically** — no database is
immune to a mistaken bulk delete or a Supabase-side incident. The
easiest way is still to visit `https://your-app-url.onrender.com/api/data`
in a browser every so often and save the page (Ctrl+S) as a JSON
backup, exactly like before. Supabase also offers built-in automatic
backups on its paid plans, and lets you export a full database dump
at any time from **Project Settings → Database → Backups**.

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

## Support

For questions about this tracker, contact your AFSCME Council 31 staff
representative.
