-- Migration 011: Grievance lock / hand-off
--
-- Adds a `locked_to` column (username string) to the grievances table.
-- When a grievance is first saved, the server sets locked_to = the
-- creating user's username.  Only the lock holder (or an admin) can
-- save changes or archive that grievance.  A hand-off transfers the lock
-- to another user's username.
--
-- Existing grievances are backfilled from data->>'createdBy'; if that is
-- empty, the steward column is used as the best available proxy.
-- Grievances where both are empty are left as NULL (unlocked — admins can
-- always edit them, and the first non-admin to touch them will claim the lock).
--
-- Safe to re-run (uses IF NOT EXISTS / DO NOTHING patterns).

-- 1. Add the column (idempotent)
alter table grievances
  add column if not exists locked_to text;

-- 2. Backfill existing rows
update grievances
set locked_to = coalesce(
    nullif(data->>'createdBy', ''),
    nullif(steward, '')
  )
where locked_to is null;

-- 3. Index for the hand-off query
create index if not exists idx_grievances_locked_to on grievances (locked_to);
