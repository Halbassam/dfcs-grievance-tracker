const { newDb } = require("pg-mem");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const verifyPool = new Pool();
  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await verifyPool.query(schemaSql);

  const pgModulePath = require.resolve("pg");
  require.cache[pgModulePath] = { id: pgModulePath, filename: pgModulePath, loaded: true, exports: { Pool } };
  process.env.DATABASE_URL = "postgres://fake:fake@fake/fake";

  await require(path.join(__dirname, "..", "migrations", "seed_defaults.js"));
  await new Promise(r => setTimeout(r, 300));

  const setupLists = await verifyPool.query("select key from setup_lists order by key");
  const keys = setupLists.rows.map(r => r.key);
  assert.ok(keys.includes("Article"));
  assert.ok(keys.includes("GrievanceType"));
  assert.ok(keys.includes("Steward"));
  console.log(`✓ seeded ${keys.length} setup lists:`, keys.join(", "));

  const articleList = await verifyPool.query("select items from setup_lists where key = 'Article'");
  assert.ok(articleList.rows[0].items.length > 50);
  console.log(`✓ Article list seeded with ${articleList.rows[0].items.length} entries`);

  const holidays = await verifyPool.query("select count(*) from holidays");
  assert.ok(Number(holidays.rows[0].count) > 30);
  console.log(`✓ seeded ${holidays.rows[0].count} holidays`);

  // Re-run to confirm idempotency / "don't clobber customizations"
  await verifyPool.query("update setup_lists set items = '[\"Custom Status Only\"]'::jsonb where key = 'Status'");
  delete require.cache[require.resolve(path.join(__dirname, "..", "migrations", "seed_defaults.js"))];
  await require(path.join(__dirname, "..", "migrations", "seed_defaults.js"));
  await new Promise(r => setTimeout(r, 300));

  const statusAfter = await verifyPool.query("select items from setup_lists where key = 'Status'");
  assert.deepStrictEqual(statusAfter.rows[0].items, ["Custom Status Only"]);
  console.log("✓ re-running seed script does NOT overwrite a list that's already been customized");

  console.log("\nAll seed-script self-tests passed.");
  process.exit(0);
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
