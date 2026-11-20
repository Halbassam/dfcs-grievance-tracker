-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 018: Shared contact links for union members.
--
-- A link is not personal. One link per location is emailed to that location's
-- employees, and each person who uses it enters their own details. Stewards
-- can see the submissions and revoke a link.
--   contact_links:       one row per link. Only a SHA-256 hash of the token is stored.
--   contact_submissions: one row per person who submits.
--
-- Safe to re-run.

create table if not exists contact_links (
  token_hash  text primary key,
  location    text not null,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index if not exists idx_contact_links_location on contact_links (location);

create table if not exists contact_submissions (
  id             text primary key,
  location       text not null,
  legal_name     text not null default '',
  phone          text not null default '',
  personal_email text not null default '',
  state_email    text not null default '',
  consent_at     timestamptz not null default now(),
  submitted_at   timestamptz not null default now()
);

create index if not exists idx_contact_submissions_location on contact_submissions (location);

alter table contact_links enable row level security;
alter table contact_submissions enable row level security;
