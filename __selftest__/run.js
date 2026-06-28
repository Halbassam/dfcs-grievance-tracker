/**
 * Self-test harness — NOT part of the deployed app.
 *
 * Uses pg-mem (an in-memory Postgres-compatible engine) to run the
 * REAL schema and the REAL server/db.js against something that
 * actually parses and executes SQL, so we catch genuine query bugs
 * before ever touching the real Supabase database.
 *
 * This file is for local verification only and is not deployed.
 */

const { newDb } = require("pg-mem");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem can hand back a "pg"-compatible Pool implementation
  const { Pool } = mem.adapters.createPg();
  const realPool = new Pool();

  // Monkey-patch our pool.js module's exports before db.js requires it,
  // by intercepting the module cache.
  const poolModulePath = path.join(__dirname, "..", "server", "pool.js");
  require.cache[require.resolve(poolModulePath)] = {
    id: poolModulePath,
    filename: poolModulePath,
    loaded: true,
    exports: {
      pool: realPool,
      query: (text, params) => realPool.query(text, params),
      withTransaction: async (fn) => {
        const client = await realPool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }
  };

  // Run the real schema file
  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await realPool.query(schemaSql);
  console.log("✓ schema applied successfully");

  const db = require(path.join(__dirname, "..", "server", "db.js"));

  // ---------- Test 1: getAll on empty DB ----------
  let all = await db.getAll();
  assert.deepStrictEqual(all.grievances, []);
  assert.deepStrictEqual(all.users, []);
  assert.strictEqual(all.lastEmailRunDate, "");
  console.log("✓ getAll() on empty DB returns correct empty shape");

  const noUsersYet = await db.hasAnyUsers();
  assert.strictEqual(noUsersYet, false);
  console.log("✓ hasAnyUsers() correctly reports false before any account exists");

  // ---------- Test 2: setup lists ----------
  await db.updateSetupList("Status", ["Pending", "Granted", "Denied"]);
  await db.updateSetupList("Location", ["North Suburban (1N)", "  ", "Roseland (1S)"]);
  all = await db.getAll();
  assert.deepStrictEqual(all.setup.Status, ["Pending", "Granted", "Denied"]);
  assert.deepStrictEqual(all.setup.Location, ["North Suburban (1N)", "Roseland (1S)"]); // blank trimmed out
  console.log("✓ updateSetupList trims blanks and persists correctly");

  let threw = false;
  try {
    await db.updateSetupList("NotARealKey", ["x"]);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true);
  console.log("✓ updateSetupList rejects unknown keys");

  // ---------- Test 3: stewards (paired list) ----------
  await db.updateStewards(["Hazem Albassam", "Maria Perez"], ["hazem@x.gov", "maria@x.gov"]);
  all = await db.getAll();
  assert.deepStrictEqual(all.setup.Steward, ["Hazem Albassam", "Maria Perez"]);
  assert.deepStrictEqual(all.setup.StewardEmail, ["hazem@x.gov", "maria@x.gov"]);
  console.log("✓ updateStewards persists paired lists correctly");

  // ---------- Test 4: holidays ----------
  await db.updateHolidays([
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "bad-date", name: "Should be filtered" }
  ]);
  all = await db.getAll();
  assert.strictEqual(all.holidays.length, 2);
  assert.strictEqual(all.holidays[0].date, "2026-01-01"); // sorted
  assert.strictEqual(all.holidays[1].date, "2026-12-25");
  console.log("✓ updateHolidays sorts and filters invalid dates");

  // ---------- Test 5: user account lifecycle ----------
  const created = await db.upsertUser({ username: "Hazem", displayName: "Hazem Albassam", password: "correct-horse-battery" });
  assert.strictEqual(created.isNew, true);
  assert.strictEqual(created.role, "admin"); // first-ever account is always auto-promoted to admin
  console.log("✓ the very first account created is automatically an admin");

  const someUsersNow = await db.hasAnyUsers();
  assert.strictEqual(someUsersNow, true);
  console.log("✓ hasAnyUsers() correctly reports true once an account exists");

  const loginFail = await db.verifyLogin("hazem", "wrong-password");
  assert.strictEqual(loginFail, null);

  const loginOk = await db.verifyLogin("HAZEM", "correct-horse-battery"); // case-insensitive username
  assert.ok(loginOk);
  assert.strictEqual(loginOk.username, "hazem");
  assert.strictEqual(loginOk.role, "admin");
  console.log("✓ user creation + login verification works, username is case-insensitive, role is returned");

  // password-blank update should NOT change the password
  await db.upsertUser({ username: "hazem", displayName: "Hazem A.", password: "" });
  const stillOk = await db.verifyLogin("hazem", "correct-horse-battery");
  assert.ok(stillOk);
  console.log("✓ blank password on upsert preserves existing password");

  const usersSafe = await db.listUsersSafe();
  assert.strictEqual(usersSafe.length, 1);
  assert.strictEqual(usersSafe[0].passwordHash, undefined); // never leak hash
  assert.strictEqual(usersSafe[0].role, "admin");
  console.log("✓ listUsersSafe never exposes password hash, includes role");

  // ---------- Test 5b: roles — second account defaults to steward, promotion/demotion, last-admin guard ----------
  const maria = await db.upsertUser({ username: "maria", displayName: "Maria Perez", password: "pw12345" });
  assert.strictEqual(maria.role, "steward"); // NOT auto-admin — only the first-ever account gets that
  console.log("✓ the second account created defaults to steward, not admin");

  const mariaExplicitAdmin = await db.upsertUser({ username: "maria", displayName: "Maria Perez", role: "admin" });
  assert.strictEqual(mariaExplicitAdmin.role, "admin");
  console.log("✓ an existing steward can be promoted to admin via upsertUser({ role: 'admin' })");

  // Now there are two admins (hazem, maria) — demoting maria back to steward should be fine.
  const mariaBackToSteward = await db.upsertUser({ username: "maria", displayName: "Maria Perez", role: "steward" });
  assert.strictEqual(mariaBackToSteward.role, "steward");
  console.log("✓ demoting an admin to steward works when another admin still exists");

  // Demoting hazem now should also be fine, since maria... wait, maria is steward again.
  // Re-promote maria so we can safely test demoting hazem without hitting the guard accidentally.
  await db.upsertUser({ username: "maria", displayName: "Maria Perez", role: "admin" });
  const hazemDemoted = await db.upsertUser({ username: "hazem", displayName: "Hazem Albassam", role: "steward" });
  assert.strictEqual(hazemDemoted.role, "steward");
  console.log("✓ demoting hazem to steward works while maria is still an admin");

  // Now maria is the ONLY admin. Demoting her should be blocked.
  let demoteBlocked = false;
  try {
    await db.upsertUser({ username: "maria", displayName: "Maria Perez", role: "steward" });
  } catch (e) {
    demoteBlocked = true;
    assert.ok(/only admin account left/i.test(e.message));
  }
  assert.strictEqual(demoteBlocked, true);
  console.log("✓ demoting the LAST remaining admin is blocked with a clear error");

  // Deleting the last remaining admin should also be blocked.
  let deleteBlocked = false;
  try {
    await db.deleteUser("maria");
  } catch (e) {
    deleteBlocked = true;
    assert.ok(/only admin account left/i.test(e.message));
  }
  assert.strictEqual(deleteBlocked, true);
  console.log("✓ deleting the LAST remaining admin is blocked with a clear error");

  // Re-promote hazem so there are two admins again, then deleting maria should work fine.
  await db.upsertUser({ username: "hazem", displayName: "Hazem Albassam", role: "admin" });
  await db.deleteUser("maria");
  const usersAfterMariaDelete = await db.listUsersSafe();
  assert.strictEqual(usersAfterMariaDelete.length, 1);
  assert.strictEqual(usersAfterMariaDelete[0].username, "hazem");
  console.log("✓ deleting a non-last admin works fine once another admin exists");

  // ---------- Test 6: sessions ----------
  const token = await db.createSession("hazem");
  const sessUser = await db.getSessionUser(token);
  assert.strictEqual(sessUser.username, "hazem");
  assert.strictEqual(sessUser.role, "admin");

  await db.destroySession(token);
  const afterDestroy = await db.getSessionUser(token);
  assert.strictEqual(afterDestroy, null);
  console.log("✓ session create/lookup/destroy works correctly, role is included");

  // ---------- Test 7: deleteUser cascades sessions ----------
  // hazem is currently the only account/admin again, so promote a throwaway
  // second admin first, otherwise this delete would correctly be blocked
  // by the last-admin guard we just tested above.
  await db.upsertUser({ username: "temp_admin", displayName: "Temp Admin", password: "pw", role: "admin" });
  const token2 = await db.createSession("hazem");
  await db.deleteUser("hazem");
  const afterUserDelete = await db.getSessionUser(token2);
  assert.strictEqual(afterUserDelete, null);
  console.log("✓ deleting a user invalidates their sessions (FK cascade)");

  // recreate hazem for remaining tests, then clean up the throwaway admin
  await db.upsertUser({ username: "hazem", displayName: "Hazem Albassam", password: "pw", role: "admin" });
  await db.deleteUser("temp_admin");

  // ---------- Test 8: grievance submit (new + update, date-field preservation) ----------
  const g1 = await db.submitGrievance({
    id: "2026-001",
    employee: "Jane Doe",
    steward: "Hazem Albassam",
    status: "Pending",
    step1filed: "2026-06-01",
    actingUser: "Hazem Albassam"
  });
  assert.strictEqual(g1.isNew, true);
  assert.strictEqual(g1.record.step1filed, "2026-06-01");

  // Update without sending step1filed again — must be preserved, not wiped
  const g2 = await db.submitGrievance({
    id: "2026-001",
    employee: "Jane Doe",
    steward: "Hazem Albassam",
    status: "Pending",
    step1resp: "2026-06-10",
    actingUser: "Hazem Albassam"
  });
  assert.strictEqual(g2.isNew, false);
  assert.strictEqual(g2.record.step1filed, "2026-06-01"); // preserved!
  assert.strictEqual(g2.record.step1resp, "2026-06-10");
  console.log("✓ submitGrievance preserves prior date fields when not resent (matches original VBA-migration behavior)");

  // ---------- Test 9: activity log ----------
  await db.logActivity({ gid: "2026-001", date: "2026-06-02", type: "Step 1 - Oral Grievance Raised with Supervisor", steward: "Hazem Albassam", actingUser: "Hazem Albassam" });
  all = await db.getAll();
  assert.strictEqual(all.activity.length, 1);
  assert.strictEqual(all.activity[0].gid, "2026-001");
  console.log("✓ logActivity persists entries correctly");

  // ---------- Test 10: findUpcomingDeadlines (with a deadline that should actually match) ----------
  // step1filed today -> step1Due = 10 working days from now, well within a 30-day window.
  const todayISO = new Date().toISOString().slice(0, 10);
  await db.submitGrievance({
    id: "2026-003",
    employee: "Urgent Case",
    steward: "Hazem Albassam",
    stewardEmail: "hazem.albassam@illinois.gov",
    status: "Pending",
    step1filed: todayISO,
    actingUser: "Hazem Albassam"
  });
  const upcomingWide = await db.findUpcomingDeadlines(30);
  assert.ok(Array.isArray(upcomingWide));
  const found = upcomingWide.find(u => u.id === "2026-003");
  assert.ok(found, "expected 2026-003's Step 1 deadline to show up within a 30-day window");
  assert.strictEqual(found.deadlineLabel, "Step 1 response");
  assert.strictEqual(found.stewardEmail, "hazem.albassam@illinois.gov");
  console.log(`✓ findUpcomingDeadlines correctly finds a real upcoming deadline (due ${found.deadlineDate}, in ${found.daysAway} day(s))`);

  const upcomingNarrow = await db.findUpcomingDeadlines(0);
  const notFoundNarrow = upcomingNarrow.find(u => u.id === "2026-003");
  assert.strictEqual(notFoundNarrow, undefined, "a deadline 10+ working days out should NOT show up in a 0-day window");
  console.log("✓ findUpcomingDeadlines correctly excludes deadlines outside the requested window");

  const upcoming = await db.findUpcomingDeadlines(365); // wide window, used by later tests below

  // ---------- Test 11: archiveClosed ----------
  await db.submitGrievance({ id: "2026-002", employee: "John Smith", steward: "Maria Perez", status: "Settled", actingUser: "Hazem Albassam" });
  const archiveResult = await db.archiveClosed();
  assert.strictEqual(archiveResult.archivedCount, 1);
  all = await db.getAll();
  assert.strictEqual(all.grievances.length, 2); // 2026-001 and 2026-003 still active; 2026-002 archived
  assert.strictEqual(all.archive.length, 1);
  assert.strictEqual(all.archive[0].id, "2026-002");
  assert.ok(all.archive[0].archivedAt);
  console.log("✓ archiveClosed moves only terminal-status grievances, preserves the rest");

  // ---------- Test 12: writeRawAtomic (email log + meta, as used by scheduler.js) ----------
  await db.writeRawAtomic({
    lastEmailRunDate: "2026-06-27",
    emailLog: [{ date: new Date().toISOString(), sent: 2, skippedNoEmail: 0, errors: [], stewardsNotified: [] }]
  });
  all = await db.getAll();
  assert.strictEqual(all.lastEmailRunDate, "2026-06-27");
  assert.strictEqual(all.emailLog.length, 1);
  assert.strictEqual(all.emailLog[0].sent, 2);
  console.log("✓ writeRawAtomic records lastEmailRunDate and emailLog entries");

  console.log("\nAll self-tests passed.");
  await realPool.end();
}

main().catch((err) => {
  console.error("\n✗ SELF-TEST FAILED:", err);
  process.exit(1);
});
