-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 019: One-time update links for a member's own contact entry.
--
-- A steward sends a link to the person's personal email on file. The link opens
-- a blank form for that one entry. Only a SHA-256 hash of the token is stored.
--
-- Safe to re-run.

create table if not exists contact_update_links (
  token_hash    text primary key,
  submission_id text not null,
  sent_to       text not null default '',
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create index if not exists idx_contact_update_links_submission on contact_update_links (submission_id);

alter table contact_update_links enable row level security;
