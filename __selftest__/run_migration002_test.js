const { newDb } = require("pg-mem");
const fs = require("fs");
const assert = require("assert");

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  // Simulate an OLD schema (users table WITHOUT a role column) —
  // i.e. someone who deployed before this feature existed.
  await pool.query(`
    create table users (
      username text primary key,
      display_name text not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(
    "insert into users (username, display_name, password_hash) values ('albassam', 'Hazem Albassam', 'scrypt:abc:def')"
  );

  console.log("✓ simulated an old pre-role schema with one existing user");

  // Now apply migration 002
  const sql002 = fs.readFileSync("/home/claude/dfcs-new/migrations/002_add_roles.sql", "utf8");
  await pool.query(sql002);
  console.log("✓ 002_add_roles.sql applied without error");

  const res = await pool.query("select username, role from users");
  assert.strictEqual(res.rows[0].role, "steward"); // existing accounts default to steward
  console.log("✓ existing account defaults to role='steward' after migration 002");

  // Confirm the documented manual promotion step works
  await pool.query("update users set role = 'admin' where username = 'albassam'");
  const res2 = await pool.query("select role from users where username = 'albassam'");
  assert.strictEqual(res2.rows[0].role, "admin");
  console.log("✓ manual promotion via UPDATE (as documented in the migration file) works");

  // Confirm the check constraint actually rejects garbage values
  let rejected = false;
  try {
    await pool.query("update users set role = 'superuser' where username = 'albassam'");
  } catch (e) {
    rejected = true;
  }
  assert.strictEqual(rejected, true);
  console.log("✓ check constraint rejects invalid role values");

  // Confirm re-running 002 is safe (idempotent)
  await pool.query(sql002);
  console.log("✓ re-running 002_add_roles.sql a second time does not error");

  console.log("\nAll migration-002 upgrade-path tests passed.");
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
