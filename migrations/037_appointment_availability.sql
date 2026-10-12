-- APT-002: staff working hours and time-off conflict enforcement.
begin;

alter table public.appointment_staff
 add column schedule_version bigint not null default 1 check (schedule_version > 0);

create table public.appointment_staff_working_hours (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 staff_id uuid not null,
 weekday smallint not null check (weekday between 1 and 7),
 start_time time not null,
 end_time time not null,
 timezone_name text not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 foreign key (staff_id, organization_id)
  references public.appointment_staff(id, organization_id) on delete cascade,
 unique (organization_id, staff_id, weekday, start_time),
 check (end_time > start_time),
 check (length(btrim(timezone_name)) between 1 and 100)
);

create index appointment_staff_hours_lookup
 on public.appointment_staff_working_hours(organization_id, staff_id, weekday, start_time, end_time);
create index appointment_staff_hours_created_by
 on public.appointment_staff_working_hours(created_by);

create table public.appointment_staff_time_off (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 staff_id uuid not null,
 start_at timestamptz not null,
 end_at timestamptz not null,
 reason text not null check (length(btrim(reason)) between 1 and 1000),
 status text not null default 'active' check (status in ('active', 'canceled')),
 version bigint not null default 1 check (version > 0),
 created_by uuid not null references auth.users(id),
 canceled_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 canceled_at timestamptz,
 foreign key (staff_id, organization_id)
  references public.appointment_staff(id, organization_id),
 unique (organization_id, id),
 check (end_at > start_at),
 check ((status = 'canceled') = (canceled_at is not null))
);

create index appointment_staff_time_off_active_lookup
 on public.appointment_staff_time_off(organization_id, staff_id, start_at, end_at)
 where status = 'active';
create index appointment_staff_time_off_created_by
 on public.appointment_staff_time_off(created_by);
create index appointment_staff_time_off_canceled_by
 on public.appointment_staff_time_off(canceled_by) where canceled_by is not null;

alter table public.appointment_staff_working_hours enable row level security;
alter table public.appointment_staff_time_off enable row level security;

create policy appointment_member_read on public.appointment_staff_working_hours
 for select to authenticated
 using ((select private.has_organization_role(
  organization_id, array['owner', 'admin', 'member']::text[]
 )));
create policy appointment_member_read on public.appointment_staff_time_off
 for select to authenticated
 using ((select private.has_organization_role(
  organization_id, array['owner', 'admin', 'member']::text[]
 )));

revoke all on public.appointment_staff_working_hours from public, anon, authenticated;
revoke all on public.appointment_staff_time_off from public, anon, authenticated;
grant select on public.appointment_staff_working_hours to authenticated;
grant select on public.appointment_staff_time_off to authenticated;

create function private.appointment_within_staff_hours(
 p_organization_id uuid,
 p_staff_id uuid,
 p_start_at timestamptz,
 p_occupied_end timestamptz
) returns boolean
language sql stable security definer set search_path = '' as $$
 select not exists (
  select 1 from public.appointment_staff_working_hours h
  where h.organization_id = p_organization_id and h.staff_id = p_staff_id
 ) or exists (
  select 1 from public.appointment_staff_working_hours h
  where h.organization_id = p_organization_id and h.staff_id = p_staff_id
   and extract(isodow from p_start_at at time zone h.timezone_name)::smallint = h.weekday
   and (p_start_at at time zone h.timezone_name)::date =
       (p_occupied_end at time zone h.timezone_name)::date
   and (p_start_at at time zone h.timezone_name)::time >= h.start_time
   and (p_occupied_end at time zone h.timezone_name)::time <= h.end_time
 );
$$;
revoke all on function private.appointment_within_staff_hours(uuid, uuid, timestamptz, timestamptz)
 from public, anon, authenticated;

create function private.enforce_appointment_staff_availability()
returns trigger language plpgsql security definer set search_path = '' as $$
declare occupied_end timestamptz;
begin
 occupied_end := new.end_at + make_interval(mins => new.buffer_minutes);
 if new.status in ('reserved', 'confirmed', 'checked_in') then
  if not private.appointment_within_staff_hours(
   new.organization_id, new.staff_id, new.start_at, occupied_end
  ) then
   raise exception 'Appointment outside staff working hours' using errcode = 'P0001';
  end if;
  if exists (
   select 1 from public.appointment_staff_time_off o
   where o.organization_id = new.organization_id and o.staff_id = new.staff_id
    and o.status = 'active' and o.start_at < occupied_end and new.start_at < o.end_at
  ) then
   raise exception 'Appointment overlaps staff time off' using errcode = 'P0001';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.enforce_appointment_staff_availability()
 from public, anon, authenticated;

create trigger appointments_staff_availability
 before insert or update of staff_id, start_at, end_at, buffer_minutes, status
 on public.appointments for each row
 execute function private.enforce_appointment_staff_availability();

create function public.replace_appointment_staff_hours(
 p_organization_id uuid,
 p_staff_id uuid,
 p_timezone_name text,
 p_hours jsonb,
 p_expected_version bigint,
 p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 staff public.appointment_staff%rowtype;
 prior public.appointment_operations%rowtype;
 fingerprint text;
 result jsonb;
 item jsonb;
 weekday_value smallint;
 start_value time;
 end_value time;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_staff_id is null or p_operation_id is null or p_expected_version is null
  or p_expected_version < 1 or p_timezone_name is null
  or length(btrim(p_timezone_name)) not between 1 and 100
  or p_hours is null or jsonb_typeof(p_hours) <> 'array'
  or jsonb_array_length(p_hours) > 21 then
  raise exception 'Invalid working hours' using errcode = '22023';
 end if;
 begin
  perform timezone(btrim(p_timezone_name), now());
 exception when invalid_parameter_value then
  raise exception 'Invalid timezone' using errcode = '22023';
 end;
 fingerprint := md5(jsonb_build_object(
  'kind', 'staff_hours', 'staff', p_staff_id, 'timezone', btrim(p_timezone_name),
  'hours', p_hours, 'version', p_expected_version
 )::text);
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-operation:' || p_organization_id::text || p_operation_id::text, 0
 ));
 select * into prior from public.appointment_operations
 where organization_id = p_organization_id and operation_id = p_operation_id;
 if found then
  if prior.actor_id <> auth.uid() or prior.fingerprint <> fingerprint then
   raise exception 'Operation conflict' using errcode = 'P0001';
  end if;
  return prior.result_snapshot;
 end if;
 select * into staff from public.appointment_staff
 where organization_id = p_organization_id and id = p_staff_id for update;
 if not found then raise exception 'Staff not found' using errcode = 'P0002'; end if;
 if staff.schedule_version <> p_expected_version then
  raise exception 'Staff schedule changed' using errcode = 'P0001';
 end if;
 delete from public.appointment_staff_working_hours
 where organization_id = p_organization_id and staff_id = p_staff_id;
 for item in select value from jsonb_array_elements(p_hours) loop
  if jsonb_typeof(item) <> 'object'
   or not (item ?& array['weekday', 'start', 'end'])
   or (item - array['weekday', 'start', 'end']) <> '{}'::jsonb
   or jsonb_typeof(item -> 'weekday') <> 'number'
   or jsonb_typeof(item -> 'start') <> 'string'
   or jsonb_typeof(item -> 'end') <> 'string' then
   raise exception 'Invalid working hour item' using errcode = '22023';
  end if;
  begin
   weekday_value := (item ->> 'weekday')::smallint;
   start_value := (item ->> 'start')::time;
   end_value := (item ->> 'end')::time;
  exception when others then
   raise exception 'Invalid working hour value' using errcode = '22023';
  end;
  if weekday_value not between 1 and 7 or end_value <= start_value then
   raise exception 'Invalid working hour range' using errcode = '22023';
  end if;
  insert into public.appointment_staff_working_hours(
   organization_id, staff_id, weekday, start_time, end_time, timezone_name, created_by
  ) values (
   p_organization_id, p_staff_id, weekday_value, start_value, end_value,
   btrim(p_timezone_name), auth.uid()
  );
 end loop;
 if exists (
  select 1 from public.appointments a
  where a.organization_id = p_organization_id and a.staff_id = p_staff_id
   and a.status in ('reserved', 'confirmed', 'checked_in')
   and not private.appointment_within_staff_hours(
    a.organization_id, a.staff_id, a.start_at,
    a.end_at + make_interval(mins => a.buffer_minutes)
   )
 ) then
  raise exception 'Working hours exclude an active appointment' using errcode = 'P0001';
 end if;
 update public.appointment_staff set schedule_version = schedule_version + 1
 where organization_id = p_organization_id and id = p_staff_id returning * into staff;
 select jsonb_build_object(
  'staff_id', staff.id,
  'schedule_version', staff.schedule_version,
  'timezone_name', btrim(p_timezone_name),
  'hours', coalesce(jsonb_agg(jsonb_build_object(
   'id', h.id, 'organization_id', h.organization_id, 'staff_id', h.staff_id,
   'weekday', h.weekday, 'start_time', h.start_time,
   'end_time', h.end_time, 'timezone_name', h.timezone_name
  ) order by h.weekday, h.start_time), '[]'::jsonb)
 ) into result
 from public.appointment_staff_working_hours h
 where h.organization_id = p_organization_id and h.staff_id = p_staff_id;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, result);
 return result;
end $$;
revoke all on function public.replace_appointment_staff_hours(uuid, uuid, text, jsonb, bigint, uuid)
 from public, anon;
grant execute on function public.replace_appointment_staff_hours(uuid, uuid, text, jsonb, bigint, uuid)
 to authenticated;

create function public.create_appointment_staff_time_off(
 p_organization_id uuid,
 p_staff_id uuid,
 p_start_at timestamptz,
 p_end_at timestamptz,
 p_reason text,
 p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 row_value public.appointment_staff_time_off%rowtype;
 prior public.appointment_operations%rowtype;
 fingerprint text;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_staff_id is null or p_start_at is null or p_end_at is null or p_end_at <= p_start_at
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
  or p_operation_id is null then
  raise exception 'Invalid time off' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'kind', 'staff_time_off', 'staff', p_staff_id, 'start', p_start_at,
  'end', p_end_at, 'reason', btrim(p_reason)
 )::text);
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-operation:' || p_organization_id::text || p_operation_id::text, 0
 ));
 select * into prior from public.appointment_operations
 where organization_id = p_organization_id and operation_id = p_operation_id;
 if found then
  if prior.actor_id <> auth.uid() or prior.fingerprint <> fingerprint then
   raise exception 'Operation conflict' using errcode = 'P0001';
  end if;
  return prior.result_snapshot;
 end if;
 perform 1 from public.appointment_staff
 where organization_id = p_organization_id and id = p_staff_id and is_active for update;
 if not found then raise exception 'Active staff not found' using errcode = 'P0002'; end if;
 if exists (
  select 1 from public.appointment_staff_time_off o
  where o.organization_id = p_organization_id and o.staff_id = p_staff_id
   and o.status = 'active' and o.start_at < p_end_at and p_start_at < o.end_at
 ) then
  raise exception 'Time off overlaps existing time off' using errcode = 'P0001';
 end if;
 if exists (
  select 1 from public.appointments a
  where a.organization_id = p_organization_id and a.staff_id = p_staff_id
   and a.status in ('reserved', 'confirmed', 'checked_in')
   and a.start_at < p_end_at
   and p_start_at < a.end_at + make_interval(mins => a.buffer_minutes)
 ) then
  raise exception 'Time off overlaps an active appointment' using errcode = 'P0001';
 end if;
 insert into public.appointment_staff_time_off(
  organization_id, staff_id, start_at, end_at, reason, created_by
 ) values (
  p_organization_id, p_staff_id, p_start_at, p_end_at, btrim(p_reason), auth.uid()
 ) returning * into row_value;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, to_jsonb(row_value));
 return to_jsonb(row_value);
end $$;
revoke all on function public.create_appointment_staff_time_off(uuid, uuid, timestamptz, timestamptz, text, uuid)
 from public, anon;
grant execute on function public.create_appointment_staff_time_off(uuid, uuid, timestamptz, timestamptz, text, uuid)
 to authenticated;

create function public.cancel_appointment_staff_time_off(
 p_organization_id uuid,
 p_time_off_id uuid,
 p_expected_version bigint,
 p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 row_value public.appointment_staff_time_off%rowtype;
 prior public.appointment_operations%rowtype;
 fingerprint text;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_time_off_id is null or p_expected_version is null or p_expected_version < 1
  or p_operation_id is null then
  raise exception 'Invalid time off cancellation' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'kind', 'cancel_staff_time_off', 'id', p_time_off_id, 'version', p_expected_version
 )::text);
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-operation:' || p_organization_id::text || p_operation_id::text, 0
 ));
 select * into prior from public.appointment_operations
 where organization_id = p_organization_id and operation_id = p_operation_id;
 if found then
  if prior.actor_id <> auth.uid() or prior.fingerprint <> fingerprint then
   raise exception 'Operation conflict' using errcode = 'P0001';
  end if;
  return prior.result_snapshot;
 end if;
 select * into row_value from public.appointment_staff_time_off
 where organization_id = p_organization_id and id = p_time_off_id for update;
 if not found then raise exception 'Time off not found' using errcode = 'P0002'; end if;
 if row_value.status <> 'active' or row_value.version <> p_expected_version then
  raise exception 'Time off changed' using errcode = 'P0001';
 end if;
 update public.appointment_staff_time_off
 set status = 'canceled', version = version + 1,
  canceled_by = auth.uid(), canceled_at = now()
 where organization_id = p_organization_id and id = p_time_off_id
 returning * into row_value;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, to_jsonb(row_value));
 return to_jsonb(row_value);
end $$;
revoke all on function public.cancel_appointment_staff_time_off(uuid, uuid, bigint, uuid)
 from public, anon;
grant execute on function public.cancel_appointment_staff_time_off(uuid, uuid, bigint, uuid)
 to authenticated;

commit;
