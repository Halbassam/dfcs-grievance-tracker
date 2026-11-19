-- A grievance ID may exist in only ONE of grievances / archive at any time.
-- Each table's primary key already stops duplicates within itself; these
-- triggers stop the same ID appearing in both. An advisory lock per ID
-- serializes concurrent inserts so two requests can't race past the check.
-- Safe to re-run.

create or replace function enforce_unique_grievance_id() returns trigger as $$
declare other_table text;
begin
  if tg_op = 'UPDATE' and new.id = old.id then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('grievance-id:' || new.id));
  other_table := case tg_table_name when 'grievances' then 'archive' else 'grievances' end;
  if (tg_table_name = 'grievances' and exists (select 1 from archive    where id = new.id))
  or (tg_table_name = 'archive'    and exists (select 1 from grievances where id = new.id)) then
    raise exception 'Grievance ID % already exists in %', new.id, other_table
      using errcode = '23505';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_unique_id_grievances on grievances;
create trigger trg_unique_id_grievances before insert or update of id on grievances
  for each row execute function enforce_unique_grievance_id();

drop trigger if exists trg_unique_id_archive on archive;
create trigger trg_unique_id_archive before insert or update of id on archive
  for each row execute function enforce_unique_grievance_id();
