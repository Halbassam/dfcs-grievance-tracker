-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 013: Add per-steward location assignments.
--
-- server/db.js reads and writes a `locations` column on `users` (a JSON
-- array of location names a steward is restricted to) -- but no prior
-- migration file ever created this column. If your live database already
-- has it (e.g. added by hand in the Supabase SQL Editor at some point),
-- this is a safe no-op. If it does not, user management (Settings ->
-- Manage Users, and logging in) will fail with "column locations does
-- not exist" until this is run.
--
-- Safe to re-run.

alter table users add column if not exists locations jsonb not null default '[]'::jsonb;
