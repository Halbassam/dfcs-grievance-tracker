/**
 * End-to-end HTTP self-test — NOT part of the deployed app.
 *
 * Boots the REAL server/index.js (same file that runs in production)
 * against the pg-mem in-memory Postgres engine, and exercises it
 * over real HTTP requests. This is the closest we can get to a full
 * production smoke test without network access to a live database
 * from this environment.
 */

const { newDb } = require("pg-mem");
const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

function request(port, method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* not JSON, fine for static routes */ }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // ---------- Set up pg-mem and intercept pool.js before index.js loads it ----------
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const realPool = new Pool();

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

  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await realPool.query(schemaSql);

  // Prevent the real scheduler's setInterval from firing during the test
  // (it would try to hit the DB every 60s — harmless but noisy/leaky for a short-lived test process).
  process.env.GMAIL_USER = "";
  process.env.GMAIL_APP_PASSWORD = "";

  // ---------- Boot the real server on an ephemeral port ----------
  process.env.PORT = "0"; // index.js reads this BEFORE we can override listen() — handle below instead
  delete require.cache[require.resolve(path.join(__dirname, "..", "server", "index.js"))];

  // index.js calls server.listen(PORT, ...) directly using process.env.PORT,
  // and PORT=0 asks the OS for any free port — exactly what we want for an
  // isolated test run with no fixed-port collisions.
  const indexModule = require(path.join(__dirname, "..", "server", "index.js"));

  // Give the server a tick to actually bind before we query its address.
  await new Promise((r) => setTimeout(r, 200));

  // index.js doesn't export the server/port, so we recover the bound port
  // by inspecting the active handles — simplest robust way without
  // touching index.js itself (which we're deliberately not modifying further).
  const activeServer = Array.from(process._getActiveHandles ? process._getActiveHandles() : [])
    .find(h => h && h.constructor && h.constructor.name === "Server" && typeof h.address === "function");

  if (!activeServer) {
    throw new Error("Could not locate the running HTTP server to determine its port.");
  }
  const port = activeServer.address().port;
  console.log(`✓ server booted successfully on ephemeral port ${port}`);

  // ---------- Test: open-access mode before any users exist ----------
  const sessionBefore = await request(port, "GET", "/api/auth/session");
  assert.strictEqual(sessionBefore.status, 200);
  assert.strictEqual(sessionBefore.json.user.openAccess, true);
  console.log("✓ GET /api/auth/session reports open access before any account exists");

  const dataBefore = await request(port, "GET", "/api/data");
  assert.strictEqual(dataBefore.status, 200);
  assert.deepStrictEqual(dataBefore.json.grievances, []);
  console.log("✓ GET /api/data works without login in open-access mode");

  // ---------- Test: create the first user (still no login wall on this call itself) ----------
  const createUser = await request(port, "POST", "/api/users", {
    username: "albassam", displayName: "Hazem Albassam", password: "test-password-123"
  });
  assert.strictEqual(createUser.status, 200);
  assert.strictEqual(createUser.json.isNew, true);
  console.log("✓ POST /api/users creates the first account");

  // ---------- Test: now that a user exists, API routes should require login ----------
  const dataNoAuth = await request(port, "GET", "/api/data");
  assert.strictEqual(dataNoAuth.status, 401);
  console.log("✓ GET /api/data now correctly requires login after the first account is created");

  // ---------- Test: wrong password fails ----------
  const loginFail = await request(port, "POST", "/api/auth/login", { username: "albassam", password: "wrong" });
  assert.strictEqual(loginFail.status, 401);
  console.log("✓ POST /api/auth/login correctly rejects a wrong password");

  // ---------- Test: correct login succeeds and returns a session cookie ----------
  const loginOk = await request(port, "POST", "/api/auth/login", { username: "albassam", password: "test-password-123" });
  assert.strictEqual(loginOk.status, 200);
  assert.strictEqual(loginOk.json.user.username, "albassam");
  assert.strictEqual(loginOk.json.user.role, "admin"); // first-ever account, auto-promoted
  const setCookieHeader = loginOk.headers["set-cookie"];
  assert.ok(setCookieHeader && setCookieHeader[0].includes("dfcs_session="));
  const cookie = setCookieHeader[0].split(";")[0];
  console.log("✓ POST /api/auth/login succeeds, issues a session cookie, and reports admin role");

  // ---------- Test: admin creates a second account (steward by default) ----------
  const createSteward = await request(port, "POST", "/api/users", {
    username: "maria", displayName: "Maria Perez", password: "steward-pw-123"
  }, cookie);
  assert.strictEqual(createSteward.status, 200);
  assert.strictEqual(createSteward.json.role, "steward");
  console.log("✓ admin can create a second account, defaults to steward role");

  const stewardLogin = await request(port, "POST", "/api/auth/login", { username: "maria", password: "steward-pw-123" });
  assert.strictEqual(stewardLogin.status, 200);
  assert.strictEqual(stewardLogin.json.user.role, "steward");
  const stewardCookieHeader = stewardLogin.headers["set-cookie"];
  const stewardCookie = stewardCookieHeader[0].split(";")[0];
  console.log("✓ steward account logs in successfully with role: steward");

  // ---------- Test: a steward is blocked from admin-only routes (403, not a crash) ----------
  const stewardTriesUsers = await request(port, "GET", "/api/users", null, stewardCookie);
  assert.strictEqual(stewardTriesUsers.status, 403);
  console.log("✓ GET /api/users is blocked for a steward (403)");

  const stewardTriesCreateUser = await request(port, "POST", "/api/users", { username: "x", displayName: "X", password: "pw" }, stewardCookie);
  assert.strictEqual(stewardTriesCreateUser.status, 403);
  console.log("✓ POST /api/users is blocked for a steward (403)");

  const stewardTriesHolidays = await request(port, "POST", "/api/holidays", { holidays: [] }, stewardCookie);
  assert.strictEqual(stewardTriesHolidays.status, 403);
  console.log("✓ POST /api/holidays is blocked for a steward (403)");

  const stewardTriesSetupList = await request(port, "POST", "/api/setup/list", { key: "Status", items: [] }, stewardCookie);
  assert.strictEqual(stewardTriesSetupList.status, 403);
  console.log("✓ POST /api/setup/list is blocked for a steward (403)");

  const stewardTriesStewardRoster = await request(port, "POST", "/api/setup/stewards", { stewards: [], emails: [] }, stewardCookie);
  assert.strictEqual(stewardTriesStewardRoster.status, 403);
  console.log("✓ POST /api/setup/stewards is blocked for a steward (403)");

  // ---------- Test: a steward CAN still do everyday grievance/activity work ----------
  const stewardSubmitsGrievance = await request(port, "POST", "/api/grievance", {
    id: "2026-200", employee: "Test Case", steward: "Maria Perez", status: "Pending"
  }, stewardCookie);
  assert.strictEqual(stewardSubmitsGrievance.status, 200);
  console.log("✓ a steward CAN still submit grievances (not locked out of everyday work)");

  const stewardReadsData = await request(port, "GET", "/api/data", null, stewardCookie);
  assert.strictEqual(stewardReadsData.status, 200);
  assert.ok(stewardReadsData.json.grievances.some(g => g.id === "2026-200"));
  console.log("✓ a steward CAN still read the full shared grievance list");

  // ---------- Test: the admin CAN use the admin-only routes ----------
  const adminListsUsers = await request(port, "GET", "/api/users", null, cookie);
  assert.strictEqual(adminListsUsers.status, 200);
  assert.strictEqual(adminListsUsers.json.users.length, 2);
  console.log("✓ GET /api/users succeeds for the admin");

  // ---------- Test: the admin CAN edit the newly-exposed dropdown lists ----------
  // (JobClass, Shift, Bureau, County, BargainingUnit, Article, GrievanceType, Status
  // all go through this same route — JobClass stands in for all of them here.)
  const adminEditsJobClass = await request(port, "POST", "/api/setup/list", {
    key: "JobClass", items: ["Human Services Caseworker (RC-62)", "Office Associate (RC-14)"]
  }, cookie);
  assert.strictEqual(adminEditsJobClass.status, 200);
  console.log("✓ admin can POST /api/setup/list for JobClass (used by the new 'Other dropdown lists' Edit buttons)");

  const dataAfterJobClassEdit = await request(port, "GET", "/api/data", null, cookie);
  assert.deepStrictEqual(dataAfterJobClassEdit.json.setup.JobClass, ["Human Services Caseworker (RC-62)", "Office Associate (RC-14)"]);
  console.log("✓ the edited JobClass list round-trips correctly through GET /api/data (what populates the Intake Form dropdown)");

  // ---------- Test: authenticated request with the cookie succeeds ----------
  const dataAuthed = await request(port, "GET", "/api/data", null, cookie);
  assert.strictEqual(dataAuthed.status, 200);
  console.log("✓ GET /api/data succeeds when the session cookie is presented");

  // ---------- Test: submit a grievance through the real HTTP route ----------
  const submitRes = await request(port, "POST", "/api/grievance", {
    id: "2026-100", employee: "Test Employee", steward: "Hazem Albassam", status: "Pending", step1filed: "2026-06-01"
  }, cookie);
  assert.strictEqual(submitRes.status, 200);
  assert.strictEqual(submitRes.json.isNew, true);
  assert.strictEqual(submitRes.json.record.createdBy, "Hazem Albassam"); // actingUser correctly injected server-side
  console.log("✓ POST /api/grievance works end-to-end and stamps createdBy from the session");

  // ---------- Test: logout invalidates the session ----------
  const logoutRes = await request(port, "POST", "/api/auth/logout", null, cookie);
  assert.strictEqual(logoutRes.status, 200);
  const dataAfterLogout = await request(port, "GET", "/api/data", null, cookie);
  assert.strictEqual(dataAfterLogout.status, 401);
  console.log("✓ POST /api/auth/logout correctly invalidates the session");

  // ---------- Test: static file serving still works ----------
  const staticRes = await request(port, "GET", "/");
  assert.strictEqual(staticRes.status, 200);
  assert.ok(staticRes.body.includes("<!DOCTYPE html>") || staticRes.body.toLowerCase().includes("<html"));
  console.log("✓ GET / still serves the frontend index.html correctly");

  console.log("\nAll end-to-end HTTP self-tests passed.");
  activeServer.close();
  await realPool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ E2E SELF-TEST FAILED:", err);
  process.exit(1);
});
