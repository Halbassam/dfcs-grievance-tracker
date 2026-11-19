-- Catch-up migration: records objects that already exist in production but were
-- never captured in a migration, and repairs lock data. Safe to re-run.

create table if not exists investigations (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists investigation_tokens (
  token            text primary key,
  investigation_id text not null,
  type             text not null,
  witness_name     text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  submitted_at     timestamptz
);
create index if not exists investigation_tokens_inv_id on investigation_tokens (investigation_id);

-- RLS on every table (server uses a privileged direct connection; this blocks anon/public API access)
alter table activity              enable row level security;
alter table app_meta              enable row level security;
alter table archive               enable row level security;
alter table attachments           enable row level security;
alter table audit_log             enable row level security;
alter table email_log             enable row level security;
alter table grievances            enable row level security;
alter table holidays              enable row level security;
alter table investigation_tokens  enable row level security;
alter table investigations        enable row level security;
alter table sessions              enable row level security;
alter table setup_lists           enable row level security;
alter table users                 enable row level security;

-- locked_to must hold a USERNAME (server compares to currentUser.username).
-- Migration 011 backfilled display names; convert them.
update grievances g set locked_to = u.username
  from users u
 where g.locked_to is not null
   and g.locked_to not in (select username from users)
   and lower(u.display_name) = lower(g.locked_to);

-- Keep the JSON blob in sync with the column.
update grievances set data = jsonb_set(data, '{lockedTo}', to_jsonb(locked_to))
 where locked_to is not null and coalesce(data->>'lockedTo','') <> locked_to;
