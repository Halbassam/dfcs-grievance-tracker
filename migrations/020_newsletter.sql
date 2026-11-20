-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 020: Newsletter opt-in, unsubscribe links, and a record of each newsletter.
--
-- A member receives the newsletter only if they opted in and have not unsubscribed.
-- Each member has a private unsubscribe token for the links in the newsletter.
-- Newsletter records are kept for one year.
--
-- Safe to re-run.

alter table contact_submissions add column if not exists newsletter_opt_in boolean not null default false;
alter table contact_submissions add column if not exists newsletter_opt_in_at timestamptz;
alter table contact_submissions add column if not exists newsletter_unsubscribed_at timestamptz;
alter table contact_submissions add column if not exists unsubscribe_token text not null default '';

update contact_submissions set unsubscribe_token = md5(random()::text || id) where unsubscribe_token = '';

create index if not exists idx_contact_submissions_unsub on contact_submissions (unsubscribe_token);

create table if not exists newsletters (
  id           text primary key,
  subject      text not null,
  body         text not null,
  audience     text not null,
  location     text not null default '',
  address_type text not null,
  reason       text not null default '',
  sent_by      text not null default '',
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  recipients   integer not null default 0,
  sent         integer not null default 0,
  failed       integer not null default 0,
  status       text not null default 'sending'
);

alter table newsletters enable row level security;
