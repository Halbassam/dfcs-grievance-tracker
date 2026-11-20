-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 018: Shared contact link for union members.
--
-- One link for the whole local is emailed to employees. Each person chooses
-- their location from the existing location list and enters their own details.
-- Stewards can see the submissions and revoke the link.
--   contact_links:       one row per link. Only a SHA-256 hash of the token is stored.
--   contact_submissions: one row per person who submits.
--
-- Safe to re-run.

create table if not exists contact_links (
  token_hash  text primary key,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

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
