-- AFSCME Council 31 — FCRC Grievance Tracker
-- Migration 017: Merge the steward roster into the user accounts.
--
-- A person is now one record in users: login details, email, and whether they
-- appear as a steward (steward dropdown, workload, deadline and hand-off
-- emails). A steward may have no login (password_hash = '').
--
-- The old roster in setup_lists ('Steward' and 'StewardEmail') is copied across
-- by matching display names. Those setup_lists rows are left in place and are
-- no longer read. Safe to re-run.

alter table users add column if not exists email text not null default '';
alter table users add column if not exists is_steward boolean not null default false;

with names as (
  select t.value as name, t.ord
  from setup_lists s, jsonb_array_elements_text(s.items) with ordinality as t(value, ord)
  where s.key = 'Steward'
),
emails as (
  select t.value as email, t.ord
  from setup_lists s, jsonb_array_elements_text(s.items) with ordinality as t(value, ord)
  where s.key = 'StewardEmail'
)
update users u
   set is_steward = true,
       email = coalesce(e.email, '')
  from names n
  left join emails e on e.ord = n.ord
 where lower(trim(u.display_name)) = lower(trim(n.name));
