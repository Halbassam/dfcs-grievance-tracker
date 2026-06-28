-- ================================================================
-- AFSCME Council 31 — DFCS Grievance Tracker
-- Migration 002: add admin/steward roles to user accounts
--
-- Run this once in the Supabase SQL Editor, the same way you ran
-- 001_init.sql. Safe to re-run — uses IF NOT EXISTS / safe defaults.
--
-- After this runs, every EXISTING account defaults to 'steward'.
-- If you want to make sure at least one of your existing accounts is
-- an admin, run this afterwards (replace the username):
--
--   update users set role = 'admin' where username = 'albassam';
--
-- New installs that run 001_init.sql fresh after this file was added
-- to the repo don't need this step — the column is created from the
-- start. This file exists for databases that already ran the
-- original 001_init.sql before roles existed.
-- ================================================================

alter table users
  add column if not exists role text not null default 'steward';

-- Make sure the value is always one of the two roles we support.
alter table users
  drop constraint if exists users_role_check;

alter table users
  add constraint users_role_check check (role in ('admin', 'steward'));
