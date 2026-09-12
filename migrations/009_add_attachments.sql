-- Migration 009: File attachments per grievance.
--
-- Actual file bytes live in Supabase Storage (separate from Postgres --
-- doesn't count against your 500MB database quota, comes out of the
-- 1GB file-storage allowance instead). This table only stores metadata
-- and a pointer (storage_path) to where the file lives in that bucket.
-- The server is the only thing that ever talks to Storage directly
-- (using the service-role key) -- the bucket is private, and nobody
-- downloads straight from Supabase; every download is proxied through
-- this app's own login + location-access check first.

create table if not exists attachments (
  id            text primary key,
  gid           text not null,               -- the grievance this file belongs to
  filename      text not null,               -- original filename, as uploaded
  content_type  text not null,
  size_bytes    integer not null,
  storage_path  text not null,               -- object path inside the bucket
  uploaded_by   text not null,               -- username of the uploader
  uploaded_at   timestamptz not null default now()
);
create index if not exists idx_attachments_gid on attachments (gid);

-- Same pattern as every other table (see 008_enable_rls.sql): RLS on,
-- no policies. Only this app's own DATABASE_URL connection (the table
-- owner) can read/write it -- PostgREST gets nothing.
alter table attachments enable row level security;

-- Create the private bucket that will hold the actual file bytes.
-- If your Supabase role running this migration doesn't have permission
-- to insert into storage.buckets, skip this statement and instead
-- create a bucket named exactly "grievance-attachments" by hand in
-- Supabase Dashboard -> Storage -> New bucket, with "Public" turned OFF.
insert into storage.buckets (id, name, public)
values ('grievance-attachments', 'grievance-attachments', false)
on conflict (id) do nothing;
