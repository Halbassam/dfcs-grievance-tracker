-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 016: Add "read_only" role tier.
--
-- Four roles now exist:
--   admin        — full access, including the AI grievance-drafting bot
--   steward_plus — normal steward access, PLUS the AI grievance-drafting bot
--   steward      — normal steward access, bot NOT available
--   read_only    — same location-scoped view as steward (grievances,
--                  activity, workload), but cannot create, edit, delete,
--                  archive, hand off, upload attachments, or use the bot
--
-- Existing accounts are untouched. Safe to re-run.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin','steward_plus','steward','read_only'));
