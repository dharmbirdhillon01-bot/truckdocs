-- Step 8: a driver can add a truck or trailer number from his own home screen (approved demo, round 2).
-- Drivers still cannot rename or delete units: they get no new table rights, only this one server action.
-- Typing a number that already exists picks that unit; typing one the owner deleted brings it back.
-- Every add is written to the company history by the existing vehicle triggers (actor = the driver).

create or replace function public.add_unit(p_company uuid, p_kind public.vehicle_kind, p_number text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare n text; v public.vehicles;
begin
  if not private.is_member(p_company) then
    raise exception 'not a member of this company' using errcode = '42501';
  end if;
  n := upper(regexp_replace(btrim(coalesce(p_number, '')), '\s+', ' ', 'g'));
  if length(n) < 1 or length(n) > 20 then
    raise exception 'unit number must be 1 to 20 characters' using errcode = '22023';
  end if;
  select * into v from public.vehicles
   where company_id = p_company and kind = p_kind and unit_number = n for update;
  if found then
    if not v.active then update public.vehicles set active = true where id = v.id; end if;
    return v.id;
  end if;
  insert into public.vehicles (company_id, kind, unit_number) values (p_company, p_kind, n) returning * into v;
  return v.id;
end $$;

revoke all on function public.add_unit(uuid, public.vehicle_kind, text) from public, anon;
grant execute on function public.add_unit(uuid, public.vehicle_kind, text) to authenticated;
