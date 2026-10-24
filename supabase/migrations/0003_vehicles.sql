-- Step 6: trucks and trailers.
-- Owners add, rename and retire units. Units are never deleted (old documents point to them).
-- Numbers are cleaned on the server (" 101 " and "101" are the same unit; letters stored in capitals).
-- Every change is written to the company history.

alter table public.vehicles add column if not exists created_by uuid references auth.users(id);

create or replace function private.vehicle_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.unit_number := upper(regexp_replace(btrim(new.unit_number), '\s+', ' ', 'g'));
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    -- only number and active may change; the rest is fixed (also enforced by column grants)
    new.company_id := old.company_id; new.kind := old.kind;
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  return new;
end $$;

create or replace function private.vehicle_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit(new.company_id, 'vehicle.added', 'vehicle', new.id,
      jsonb_build_object('kind', new.kind, 'unit_number', new.unit_number));
  else
    if new.unit_number is distinct from old.unit_number then
      perform private.audit(new.company_id, 'vehicle.renamed', 'vehicle', new.id,
        jsonb_build_object('kind', new.kind, 'from', old.unit_number, 'to', new.unit_number));
    end if;
    if new.active is distinct from old.active then
      perform private.audit(new.company_id, case when new.active then 'vehicle.reactivated' else 'vehicle.retired' end,
        'vehicle', new.id, jsonb_build_object('kind', new.kind, 'unit_number', new.unit_number));
    end if;
  end if;
  return null;
end $$;

drop trigger if exists vehicles_before on public.vehicles;
create trigger vehicles_before before insert or update on public.vehicles
  for each row execute function private.vehicle_before();
drop trigger if exists vehicles_after on public.vehicles;
create trigger vehicles_after after insert or update on public.vehicles
  for each row execute function private.vehicle_after();
drop trigger if exists vehicles_no_delete on public.vehicles;
create trigger vehicles_no_delete before delete on public.vehicles
  for each row execute function private.forbid_change();
