/**
 * Tests migrations/migrate_from_json.js against pg-mem, using the
 * "pg" module override trick — but this time we override what
 * "pg" itself resolves to (not server/pool.js), since the migration
 * script requires("pg") directly rather than going through our pool.js.
 */

const { newDb } = require("pg-mem");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const verifyPool = new Pool();

  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await verifyPool.query(schemaSql);

  // Intercept "pg" itself so migrate_from_json.js's `require("pg")` gets
  // the pg-mem Pool instead of the real driver — but it needs to share
  // the SAME in-memory backing store as verifyPool above, so we build
  // both Pool classes from the same `mem` instance.
  const pgModulePath = require.resolve("pg");
  const original = require.cache[pgModulePath];
  require.cache[pgModulePath] = {
    id: pgModulePath,
    filename: pgModulePath,
    loaded: true,
    exports: { Pool: mem.adapters.createPg().Pool }
  };

  process.env.DATABASE_URL = "postgres://fake:fake@fake/fake"; // pg-mem ignores this, but our script checks it's set

  delete require.cache[require.resolve(path.join(__dirname, "..", "migrations", "migrate_from_json.js"))];

  // migrate_from_json.js calls process.exit() / has top-level side effects via main(),
  // so just require it — it runs immediately.
  const fixturePath = path.join(__dirname, "fixtures", "sample_tracker.json");
  process.argv = ["node", "migrate_from_json.js", fixturePath];

  await require(path.join(__dirname, "..", "migrations", "migrate_from_json.js"));

  // Give the script's internal async main() a moment to finish
  // (it's not awaited by our require since it's a bare call in that file).
  await new Promise((r) => setTimeout(r, 500));

  // ---------- Verify results using the SAME backing store ----------
  const grievances = await verifyPool.query("select * from grievances");
  assert.strictEqual(grievances.rows.length, 1);
  assert.strictEqual(grievances.rows[0].id, "2026-001");
  console.log("✓ grievances migrated correctly");

  const archive = await verifyPool.query("select * from archive");
  assert.strictEqual(archive.rows.length, 1);
  assert.strictEqual(archive.rows[0].id, "2025-099");
  console.log("✓ archive migrated correctly");

  const activity = await verifyPool.query("select * from activity");
  assert.strictEqual(activity.rows.length, 1);
  assert.strictEqual(activity.rows[0].gid, "2026-001");
  console.log("✓ activity log migrated correctly");

  const holidays = await verifyPool.query("select * from holidays order by date");
  assert.strictEqual(holidays.rows.length, 2);
  console.log("✓ holidays migrated correctly");

  const setupLists = await verifyPool.query("select * from setup_lists order by key");
  assert.strictEqual(setupLists.rows.length, 3); // Status, Steward, StewardEmail
  console.log("✓ setup lists migrated correctly");

  const emailLog = await verifyPool.query("select * from email_log");
  assert.strictEqual(emailLog.rows.length, 1);
  console.log("✓ email log migrated correctly");

  const meta = await verifyPool.query("select * from app_meta where key = 'lastEmailRunDate'");
  assert.strictEqual(meta.rows[0].value, "2026-06-27");
  console.log("✓ lastEmailRunDate migrated correctly");

  const users = await verifyPool.query("select * from users");
  assert.strictEqual(users.rows.length, 0); // intentionally skipped per requirements
  console.log("✓ users correctly NOT migrated (fresh-login-for-everyone, as requested)");

  console.log("\nAll migration-script self-tests passed.");

  require.cache[pgModulePath] = original;
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ MIGRATION SELF-TEST FAILED:", err);
  process.exit(1);
});
