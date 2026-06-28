/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * One-time migration: data/tracker.json  →  Supabase Postgres
 *
 * Run this ONCE, after the schema (001_init.sql) has been applied
 * to your Supabase database, to copy over your existing data:
 * grievances, activity log, archive, setup/dropdown lists,
 * holidays, and email log.
 *
 * Per your instructions, user accounts and sessions are
 * intentionally NOT migrated — everyone creates/re-creates their
 * login the first time they use the new database-backed version,
 * exactly like a fresh install. (See README for the "first account"
 * flow — the app opens with no login wall until the first account
 * is created from Settings > Manage users.)
 *
 * USAGE:
 *   1. Make sure DATABASE_URL is set in your environment (the same
 *      value you'll put on Render), and that 001_init.sql has
 *      already been run against that database.
 *   2. node migrations/migrate_from_json.js path/to/tracker.json
 *
 * This script is SAFE TO RE-RUN: every insert uses ON CONFLICT to
 * upsert, so running it twice with the same file won't duplicate
 * grievances, holidays, or setup lists. Activity and email log
 * entries are append-only history in the original file too, so
 * they're inserted fresh each run — only run this once per file,
 * or expect duplicate history rows if you re-run it after the data
 * has already changed.
 * ================================================================
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node migrations/migrate_from_json.js path/to/tracker.json");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("FATAL: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(inputPath), "utf8");
  const data = JSON.parse(raw);

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ---------- setup lists ----------
    const setup = data.setup || {};
    let setupCount = 0;
    for (const [key, items] of Object.entries(setup)) {
      if (!Array.isArray(items)) continue;
      await client.query(
        `insert into setup_lists (key, items) values ($1, $2::jsonb)
         on conflict (key) do update set items = excluded.items`,
        [key, JSON.stringify(items)]
      );
      setupCount++;
    }
    console.log(`✓ migrated ${setupCount} setup/dropdown list(s)`);

    // ---------- holidays ----------
    const holidays = Array.isArray(data.holidays) ? data.holidays : [];
    for (const h of holidays) {
      if (!h || !h.date || !h.name) continue;
      await client.query(
        `insert into holidays (date, name) values ($1, $2)
         on conflict (date) do update set name = excluded.name`,
        [h.date, h.name]
      );
    }
    console.log(`✓ migrated ${holidays.length} holiday(s)`);

    // ---------- grievances ----------
    const grievances = Array.isArray(data.grievances) ? data.grievances : [];
    for (const g of grievances) {
      if (!g || !g.id) continue;
      await client.query(
        `insert into grievances (id, status, steward, data, created_at, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         on conflict (id) do update
           set status = excluded.status,
               steward = excluded.steward,
               data = excluded.data,
               updated_at = excluded.updated_at`,
        [
          g.id,
          g.status || "Pending",
          g.steward || "",
          JSON.stringify(g),
          g.createdAt || new Date().toISOString(),
          g.updatedAt || new Date().toISOString()
        ]
      );
    }
    console.log(`✓ migrated ${grievances.length} active grievance(s)`);

    // ---------- archive ----------
    const archive = Array.isArray(data.archive) ? data.archive : [];
    for (const g of archive) {
      if (!g || !g.id) continue;
      await client.query(
        `insert into archive (id, status, steward, archived_at, data)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (id) do update
           set status = excluded.status,
               steward = excluded.steward,
               archived_at = excluded.archived_at,
               data = excluded.data`,
        [g.id, g.status || "", g.steward || "", g.archivedAt || "", JSON.stringify(g)]
      );
    }
    console.log(`✓ migrated ${archive.length} archived grievance(s)`);

    // ---------- activity log ----------
    const activity = Array.isArray(data.activity) ? data.activity : [];
    for (const a of activity) {
      if (!a) continue;
      await client.query(
        `insert into activity (gid, data, created_at) values ($1, $2::jsonb, $3)`,
        [a.gid || "", JSON.stringify(a), a.date ? new Date(a.date) : new Date()]
      );
    }
    console.log(`✓ migrated ${activity.length} activity log entr(ies)`);

    // ---------- email log ----------
    const emailLog = Array.isArray(data.emailLog) ? data.emailLog : [];
    // Old file kept newest-first; insert oldest-first so row_id ordering
    // (which getAll() reads newest-first via "order by row_id desc") ends
    // up matching the original chronological order.
    for (const e of [...emailLog].reverse()) {
      if (!e) continue;
      await client.query(
        `insert into email_log (data, run_at) values ($1::jsonb, $2)`,
        [JSON.stringify(e), e.date ? new Date(e.date) : new Date()]
      );
    }
    console.log(`✓ migrated ${emailLog.length} email log entr(ies)`);

    // ---------- lastEmailRunDate ----------
    if (typeof data.lastEmailRunDate === "string") {
      await client.query(
        `insert into app_meta (key, value) values ('lastEmailRunDate', $1)
         on conflict (key) do update set value = excluded.value`,
        [data.lastEmailRunDate]
      );
      console.log(`✓ migrated lastEmailRunDate (${data.lastEmailRunDate || "(blank)"})`);
    }

    // ---------- users / sessions: intentionally NOT migrated ----------
    const skippedUsers = Array.isArray(data.users) ? data.users.length : 0;
    if (skippedUsers > 0) {
      console.log(
        `ℹ skipped ${skippedUsers} existing login account(s) by design — ` +
        `everyone will need to be re-added via Settings > Manage users on the ` +
        `new database-backed app (this also means old session cookies are dropped).`
      );
    }

    await client.query("COMMIT");
    console.log("\n✅ Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n✗ Migration FAILED, all changes rolled back:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
