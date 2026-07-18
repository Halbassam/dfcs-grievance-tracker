/**
 * AFSCME Council 31 — FCRC Grievance Tracker
 * Postgres connection pool (Supabase pooled connection, port 6543).
 * Set DATABASE_URL on Render to the Supabase Connection Pooling
 * (Transaction mode) string — not the direct connection.
 */

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "FATAL: DATABASE_URL environment variable is not set. " +
    "Set it on Render to your Supabase pooled connection string."
  );
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err.message);
});

function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) { console.error("Rollback failed:", e.message); }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
