-- ================================================================
-- AFSCME Council 31 — DFCS Grievance Tracker
-- Initial Postgres schema (Supabase)
--
-- Mirrors the shape of the old data/tracker.json file as closely
-- as possible so the migration script is a near 1:1 copy, and so
-- nothing in server/db.js has to guess at field names.
--
-- Design choice: grievance and activity records keep a small set of
-- "real" columns (id, status, steward, dates used for indexing /
-- deadline math) but the full record is ALSO stored as JSONB. This
-- means a frontend field we didn't think to give its own column
-- never gets silently dropped on save — it round-trips through the
-- JSONB blob exactly as the JSON file would have kept it.
-- ================================================================

-- ---------- grievances ----------
create table if not exists grievances (
  id            text primary key,
  status        text not null default 'Pending',
  steward       text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_grievances_status on grievances (status);
create index if not exists idx_grievances_steward on grievances (steward);

-- ---------- activity log (append-only history per grievance) ----------
create table if not exists activity (
  row_id        bigint generated always as identity primary key,
  gid           text not null,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_activity_gid on activity (gid);

-- ---------- archive (closed-out grievances, same shape as grievances) ----------
create table if not exists archive (
  id            text primary key,
  status        text,
  steward       text,
  archived_at   text, -- kept as YYYY-MM-DD string to match old format exactly
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- ---------- users (login accounts) ----------
create table if not exists users (
  username       text primary key,  -- already lowercase-normalized by db.js
  display_name   text not null,
  password_hash  text not null,
  role           text not null default 'steward' check (role in ('admin', 'steward')),
  created_at     timestamptz not null default now()
);

-- ---------- sessions ----------
create table if not exists sessions (
  token       text primary key,
  username    text not null references users(username) on delete cascade,
  expires_at  timestamptz not null
);

create index if not exists idx_sessions_username on sessions (username);
create index if not exists idx_sessions_expires on sessions (expires_at);

-- ---------- holidays ----------
create table if not exists holidays (
  date  text primary key, -- YYYY-MM-DD, matches old format exactly
  name  text not null
);

-- ---------- setup / dropdown lists ----------
-- One row per list (Status, Bureau, Location, ... Steward, StewardEmail).
-- Stored as an ordered JSON array of strings so display order is preserved
-- exactly like the old JSON file (Postgres arrays don't guarantee this as
-- cleanly across all drivers, so JSONB array is simplest and safest).
create table if not exists setup_lists (
  key    text primary key,
  items  jsonb not null default '[]'::jsonb
);

-- ---------- email log (most recent runs of the daily deadline check) ----------
create table if not exists email_log (
  row_id     bigint generated always as identity primary key,
  run_at     timestamptz not null default now(),
  data       jsonb not null default '{}'::jsonb
);

-- ---------- single-row table for small global/meta values ----------
-- Mirrors the old top-level "lastEmailRunDate" field.
create table if not exists app_meta (
  key    text primary key,
  value  text
);

insert into app_meta (key, value) values ('lastEmailRunDate', '')
  on conflict (key) do nothing;
