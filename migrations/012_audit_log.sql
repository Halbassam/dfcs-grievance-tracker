-- Migration 012: Audit log
--
-- Tracks login/logout events, tab navigation, and grievance record opens.
-- Rows are append-only; nothing in the app ever updates or deletes them.
-- Retained indefinitely (cheap — text rows, no blobs).
--
-- Safe to re-run (uses IF NOT EXISTS).

create table if not exists audit_log (
  id          bigserial primary key,
  username    text        not null,
  action      text        not null,  -- 'login' | 'logout' | 'tab' | 'record_open'
  detail      text        not null default '', -- tab name, grievance ID, etc.
  ip          text        not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists idx_audit_log_username   on audit_log (username);
create index if not exists idx_audit_log_created_at on audit_log (created_at desc);
