-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 021: Union business notices to state emails.
--
-- A notice is not a newsletter. It goes only to people who gave a state email as
-- union contact, has no unsubscribe link, and is used for union business only.
-- Each send records its reason. Newsletters remain opt-in with unsubscribe.
--
-- Safe to re-run.

alter table newsletters add column if not exists kind text not null default 'newsletter';
