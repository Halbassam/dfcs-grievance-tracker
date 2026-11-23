-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 022: A record of each email sent to members, kept for one year.
--
-- One row per recipient for newsletters and union notices (newsletter_id is set), and
-- one row for each update link and update confirmation sent to a member (newsletter_id
-- is empty). The private update link itself is never stored.
--
-- Safe to re-run.

create table if not exists member_mail_log (
  row_id        bigserial primary key,
  sent_at       timestamptz not null default now(),
  kind          text not null,
  newsletter_id text not null default '',
  legal_name    text not null default '',
  email         text not null default '',
  ok            boolean not null default true,
  error         text not null default '',
  sent_by       text not null default ''
);

create index if not exists idx_member_mail_log_newsletter on member_mail_log (newsletter_id);
create index if not exists idx_member_mail_log_sent on member_mail_log (sent_at);

alter table member_mail_log enable row level security;
