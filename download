/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Password hashing — zero npm dependencies, uses Node's built-in
 * crypto.scrypt (a deliberately slow, memory-hard hash designed
 * for passwords — much safer than a plain SHA-256 hash).
 *
 * Stored format: "scrypt:<salt-hex>:<hash-hex>"
 * The salt is randomly generated per-password, so two stewards
 * with the same password never produce the same stored hash.
 * ================================================================
 */

const crypto = require("crypto");

const KEY_LENGTH = 64;

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plainPassword, salt, KEY_LENGTH).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(plainPassword, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [, salt, originalHashHex] = parts;
  const originalHash = Buffer.from(originalHashHex, "hex");
  const attemptHash = crypto.scryptSync(plainPassword, salt, KEY_LENGTH);

  if (attemptHash.length !== originalHash.length) return false;
  return crypto.timingSafeEqual(attemptHash, originalHash);
}

module.exports = { hashPassword, verifyPassword };
