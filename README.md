# DFCS Grievance Tracker

AFSCME Council 31 — Division of Family & Community Services, IDHS
Master Contract 2023–2027 | Art. V Grievance Procedure

A shared, web-based grievance tracking system for stewards. No Excel,
no macros, no spreadsheet — a real website with a shared live database
that every steward can use at the same time from any device.

---

## What's in this repo

```
dfcs-tracker/
├── package.json          (no external dependencies — pure Node.js)
├── server/
│   ├── index.js          (the web server)
│   └── db.js             (the database — a JSON file with safe writes)
└── public/
    └── index.html        (the entire frontend — forms, dashboard, etc.)
```

There is nothing to install. The server uses only Node's built-in
modules, so there is no `npm install` step that can fail.

---

### Step 4 — Protect it with a shared password

By default this app has no login screen at all. To require a password
before anyone can view or use it:

1. On the Render dashboard, open your web service.
2. Click **Environment** in the left sidebar.
3. Click **Add Environment Variable**.
4. Set:
   - **Key**: `APP_PASSWORD`
   - **Value**: whatever password you want stewards to use (e.g. `union2025`)
5. Click **Save Changes**. Render will automatically redeploy.

Once that's set, anyone opening the URL will see a browser login prompt.
The **username can be anything** (e.g. type `dfcs`) — only the password
is checked. Give your stewards the URL plus the password; the username
field can be left blank or filled with anything.

**If you ever skip Step 4, the site stays fully public with no password
at all** — this is the default so local testing never gets accidentally
locked out, but it means production use requires setting `APP_PASSWORD`.

To change the password later, just edit the `APP_PASSWORD` environment
variable value and save — no code changes needed.

---

### Step 5 — Set up automatic deadline email reminders (optional)

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

## Managing stewards, FCRC locations, and holidays

No code edits or Render shell access needed for any of this — it's
all done from inside the running app itself:

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

---

## Deploying to Render.com (free tier)

### Step 1 — Push this code to GitHub

1. Go to [github.com](https://github.com) and create a **New repository**.
   Name it `dfcs-grievance-tracker`. Keep it Public or Private, either works.
2. On the new repo's page, click **uploading an existing file**.
3. Drag in all the files and folders from this project
   (`package.json`, the `server` folder, the `public` folder, `.gitignore`).
4. Scroll down, click **Commit changes**.

### Step 2 — Create the Render account and connect GitHub

1. Go to [render.com](https://render.com) and click **Get Started**.
2. Sign up using your GitHub account (this makes Step 3 automatic).

### Step 3 — Deploy

1. From the Render dashboard, click **New** → **Web Service**.
2. Find and select your `dfcs-grievance-tracker` repository.
3. Render will detect it automatically. Fill in:
   - **Name**: `dfcs-grievance-tracker` (or anything you like — this becomes part of your URL)
   - **Region**: choose the one closest to Illinois (US East/Ohio is usually closest)
   - **Branch**: `main`
   - **Build Command**: leave as `npm install` (it will finish instantly since there are no dependencies)
   - **Start Command**: `npm start`
   - **Instance Type**: select **Free**
4. Click **Create Web Service**.
5. Wait 1–2 minutes while Render builds and deploys.
6. When it shows "Live" at the top, your URL is shown right below the
   service name — something like:
   `https://dfcs-grievance-tracker.onrender.com`

**That URL is what you give to every steward.** Everyone opens the
same link and sees the same shared, live data.

---

## A note on the free tier

Render's free web services "sleep" after 15 minutes with no traffic.
The first person to open the link after a quiet period will wait
about 20–30 seconds while it wakes up — after that, it's instant for
everyone until it goes quiet again. For a tool used by a handful of
stewards a few times a day, this is barely noticeable.

If this becomes a problem later, Render's paid tier ($7/month) removes
the sleep behavior entirely — but most locals never need this.

---

## How data is stored

All grievances, activity log entries, and archived records are stored
in a single JSON file inside the running service (`data/tracker.json`).
This file persists across normal restarts, but **Render's free tier
does not guarantee permanent disk storage** — if Render ever moves
your service to a new machine, the data file could reset.

**This means: back up your data periodically.** The easiest way is to
visit `https://your-app-url.onrender.com/api/data` in a browser every
so often and save the page (Ctrl+S) as a JSON backup. If you want
guaranteed permanent storage, that requires Render's paid Postgres
add-on — let your Council 31 staff rep know if that becomes necessary
and it can be added later without changing anything else.

---

## Updating the app later

Any time you want to change something:
1. Edit the file on GitHub directly (click the pencil icon on any file), or
2. Upload a replacement file the same way you did in Step 1.
3. Render automatically redeploys within about a minute of any GitHub change.

---

## Support

For questions about this tracker, contact your AFSCME Council 31 staff
representative.
