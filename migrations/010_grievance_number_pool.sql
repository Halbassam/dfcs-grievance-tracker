-- Migration 010: Grievance Number Pool
--
-- No new tables needed. The pool is stored entirely in the existing
-- app_meta key-value store:
--
--   grievanceNumberPool     : JSON array of remaining (unassigned) number
--                             strings, ordered FIFO.
--   grievanceNumberPoolLog  : JSON array of {number, assignedBy, assignedAt}
--                             objects, one per number that was ever assigned.
--
-- The server's db.js functions (getGrievanceNumberPool, addToGrievanceNumberPool,
-- clearGrievanceNumberPool, consumeNextGrievanceNumber) manage these keys
-- inside withLock() so concurrent intake-form submits can't duplicate a number.
--
-- This migration just seeds the two keys so they exist cleanly rather than
-- being lazily created on first use.  Running this more than once is safe
-- (ON CONFLICT DO NOTHING).

insert into app_meta (key, value)
values
  ('grievanceNumberPool',    '[]'),
  ('grievanceNumberPoolLog', '[]')
on conflict (key) do nothing;
