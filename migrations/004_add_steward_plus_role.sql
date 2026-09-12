-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 004: Add "steward_plus" role tier.
--
-- Three roles now exist:
--   admin        — full access, including the AI grievance-drafting bot
--   steward_plus — normal steward access, PLUS the AI grievance-drafting bot
--   steward      — normal steward access, bot NOT available
--
-- Existing accounts are untouched (everyone currently 'admin' or 'steward'
-- keeps that role — no one is silently granted or denied bot access).
-- Safe to re-run.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin','steward_plus','steward'));
