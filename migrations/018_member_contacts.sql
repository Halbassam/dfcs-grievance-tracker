-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 018: Member contact details collected through personal links.
--
-- member_contacts: one row per member, keyed by name (matching the roster).
--   Used for union contact only. Visible to stewards.
-- member_links: one-time links. Only a SHA-256 hash of each token is stored.
--
-- Safe to re-run.

create table if not exists member_contacts (
  member_name    text primary key,
  location       text not null default '',
  legal_name     text not null default '',
  phone          text not null default '',
  personal_email text not null default '',
  state_email    text not null default '',
  consent_at     timestamptz,
  updated_at     timestamptz not null default now(),
  updated_by     text not null default ''
);

create table if not exists member_links (
  token_hash  text primary key,
  member_name text not null,
  location    text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists idx_member_links_name on member_links (member_name);

alter table member_contacts enable row level security;
alter table member_links enable row level security;
