/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Postgres connection pool (Supabase).
 *
 * Reads DATABASE_URL from the environment. On Render, set this to
 * your Supabase project's CONNECTION POOLING string (port 6543,
 * pgbouncer) rather than the direct connection (port 5432) — Render
 * web services open/close connections in a pattern that pooled
 * mode handles much better.
 *
 * Supabase's pooled connection string looks like:
 *   postgresql://postgres.xxxxxxxx:[PASSWORD]@aws-0-REGION.pooler.supabase.com:6543/postgres
 *
 * (Different from the direct string, which uses
 *   db.xxxxxxxx.supabase.co:5432 — that one is NOT what you want here.)
 * ================================================================
 */

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Loud and immediate, same philosophy as the old ensureDataFile()
  // eager check — fail fast at startup rather than on first request.
  console.error(
    "FATAL: DATABASE_URL environment variable is not set. " +
    "Set it on Render to your Supabase pooled connection string."
  );
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS; their cert chain needs this relaxed check from most Node setups
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  // A background, idle client erroring out should never crash the process.
  console.error("Unexpected Postgres pool error:", err.message);
});

/**
 * Runs a single query against the pool. Thin wrapper so call sites
 * read cleanly as `query("select ...", [params])`.
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a single dedicated client with a transaction
 * (BEGIN/COMMIT/ROLLBACK). Use this anywhere multiple statements
 * must succeed or fail together — the direct equivalent of the old
 * withLock()-wrapped multi-step JSON read/modify/write sequences.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
