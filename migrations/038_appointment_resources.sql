-- APT-002: room/equipment catalog, service requirements, and conflict enforcement.
begin;

create table public.appointment_resources (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 name text not null check (length(btrim(name)) between 1 and 120),
 kind text not null check (kind in ('room', 'equipment')),
 is_active boolean not null default true,
 version bigint not null default 1 check (version > 0),
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organization_id, id),
 unique (organization_id, kind, name)
);

alter table public.appointment_services
 add column resource_version bigint not null default 1 check (resource_version > 0);

create table public.appointment_service_resource_requirements (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 service_id uuid not null,
 kind text not null check (kind in ('room', 'equipment')),
 quantity smallint not null check (quantity between 1 and 10),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 foreign key (service_id, organization_id)
  references public.appointment_services(id, organization_id) on delete cascade,
 unique (organization_id, service_id, kind)
);

alter table public.appointments
 add column resource_ids uuid[] not null default '{}'::uuid[]
 check (cardinality(resource_ids) <= 20 and array_position(resource_ids, null) is null);

create index appointment_resources_active_lookup
 on public.appointment_resources(organization_id, kind, name) where is_active;
create index appointment_resources_created_by on public.appointment_resources(created_by);
create index appointment_resources_updated_by on public.appointment_resources(updated_by);
create index appointment_service_requirements_lookup
 on public.appointment_service_resource_requirements(organization_id, service_id, kind);
create index appointment_service_requirements_created_by
 on public.appointment_service_resource_requirements(created_by);
create index appointments_active_resources
 on public.appointments using gin(resource_ids)
 where status in ('reserved', 'confirmed', 'checked_in');

alter table public.appointment_resources enable row level security;
alter table public.appointment_service_resource_requirements enable row level security;
create policy appointment_member_read on public.appointment_resources
 for select to authenticated using ((select private.has_organization_role(
  organization_id, array['owner', 'admin', 'member']::text[]
 )));
create policy appointment_member_read on public.appointment_service_resource_requirements
 for select to authenticated using ((select private.has_organization_role(
  organization_id, array['owner', 'admin', 'member']::text[]
 )));
revoke all on public.appointment_resources from public, anon, authenticated;
revoke all on public.appointment_service_resource_requirements from public, anon, authenticated;
grant select on public.appointment_resources to authenticated;
grant select on public.appointment_service_resource_requirements to authenticated;

create function private.enforce_appointment_resources()
returns trigger language plpgsql security definer set search_path = '' as $$
declare distinct_count integer;
begin
 select count(distinct value) into distinct_count from unnest(new.resource_ids) value;
 if distinct_count <> cardinality(new.resource_ids) then
  raise exception 'Duplicate appointment resource' using errcode = '22023';
 end if;
 if exists (
  select 1 from unnest(new.resource_ids) selected(resource_id)
  left join public.appointment_resources r
   on r.organization_id = new.organization_id and r.id = selected.resource_id and r.is_active
  where r.id is null
 ) then
  raise exception 'Active appointment resource not found' using errcode = 'P0002';
 end if;
 if exists (
  select 1 from public.appointment_service_resource_requirements requirement
  where requirement.organization_id = new.organization_id
   and requirement.service_id = new.service_id
   and requirement.quantity > (
    select count(*) from public.appointment_resources resource
    where resource.organization_id = new.organization_id
     and resource.id = any(new.resource_ids) and resource.is_active
     and resource.kind = requirement.kind
   )
 ) then
  raise exception 'Required appointment resources missing' using errcode = '22023';
 end if;
 if new.status in ('reserved', 'confirmed', 'checked_in') and cardinality(new.resource_ids) > 0
  and exists (
   select 1 from public.appointments appointment
   where appointment.organization_id = new.organization_id
    and appointment.id is distinct from new.id
    and appointment.status in ('reserved', 'confirmed', 'checked_in')
    and appointment.resource_ids && new.resource_ids
    and appointment.start_at < new.end_at + make_interval(mins => new.buffer_minutes)
    and new.start_at < appointment.end_at + make_interval(mins => appointment.buffer_minutes)
  ) then
  raise exception 'Appointment resource conflict' using errcode = 'P0001';
 end if;
 return new;
end $$;
revoke all on function private.enforce_appointment_resources() from public, anon, authenticated;
create trigger appointments_resource_guard
 before insert or update of service_id, resource_ids, start_at, end_at, buffer_minutes, status
 on public.appointments for each row execute function private.enforce_appointment_resources();

create function public.create_appointment_resource(
 p_organization_id uuid, p_name text, p_kind text, p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_value public.appointment_resources%rowtype;
 prior public.appointment_operations%rowtype; fingerprint text;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_name is null or length(btrim(p_name)) not between 1 and 120
  or p_kind is null or p_kind not in ('room', 'equipment') or p_operation_id is null then
  raise exception 'Invalid appointment resource' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'kind', 'resource_create', 'name', btrim(p_name), 'resource_kind', p_kind
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
 insert into public.appointment_resources(
  organization_id, name, kind, created_by, updated_by
 ) values (p_organization_id, btrim(p_name), p_kind, auth.uid(), auth.uid())
 returning * into row_value;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, to_jsonb(row_value));
 return to_jsonb(row_value);
end $$;
revoke all on function public.create_appointment_resource(uuid, text, text, uuid) from public, anon;
grant execute on function public.create_appointment_resource(uuid, text, text, uuid) to authenticated;

create function public.update_appointment_resource(
 p_organization_id uuid, p_resource_id uuid, p_name text, p_is_active boolean,
 p_expected_version bigint, p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_value public.appointment_resources%rowtype;
 prior public.appointment_operations%rowtype; fingerprint text;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_resource_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120
  or p_is_active is null or p_expected_version is null or p_expected_version < 1
  or p_operation_id is null then
  raise exception 'Invalid appointment resource update' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'kind', 'resource_update', 'id', p_resource_id, 'name', btrim(p_name),
  'active', p_is_active, 'version', p_expected_version
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
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-resource:' || p_organization_id::text || p_resource_id::text, 0
 ));
 select * into row_value from public.appointment_resources
 where organization_id = p_organization_id and id = p_resource_id for update;
 if not found then raise exception 'Appointment resource not found' using errcode = 'P0002'; end if;
 if row_value.version <> p_expected_version then
  raise exception 'Appointment resource changed' using errcode = 'P0001';
 end if;
 if not p_is_active and exists (
  select 1 from public.appointments appointment
  where appointment.organization_id = p_organization_id
   and appointment.status in ('reserved', 'confirmed', 'checked_in')
   and p_resource_id = any(appointment.resource_ids)
 ) then
  raise exception 'Appointment resource is in use' using errcode = 'P0001';
 end if;
 update public.appointment_resources set name = btrim(p_name), is_active = p_is_active,
  version = version + 1, updated_by = auth.uid(), updated_at = now()
 where organization_id = p_organization_id and id = p_resource_id returning * into row_value;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, to_jsonb(row_value));
 return to_jsonb(row_value);
end $$;
revoke all on function public.update_appointment_resource(uuid, uuid, text, boolean, bigint, uuid)
 from public, anon;
grant execute on function public.update_appointment_resource(uuid, uuid, text, boolean, bigint, uuid)
 to authenticated;

create function public.replace_appointment_service_resource_requirements(
 p_organization_id uuid, p_service_id uuid, p_requirements jsonb,
 p_expected_version bigint, p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare service public.appointment_services%rowtype; prior public.appointment_operations%rowtype;
 fingerprint text; item jsonb; kind_value text; quantity_value smallint; result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_service_id is null or p_requirements is null or jsonb_typeof(p_requirements) <> 'array'
  or jsonb_array_length(p_requirements) > 2 or p_expected_version is null
  or p_expected_version < 1 or p_operation_id is null then
  raise exception 'Invalid resource requirements' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'kind', 'service_resources', 'service', p_service_id,
  'requirements', p_requirements, 'version', p_expected_version
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
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-service:' || p_organization_id::text || p_service_id::text, 0
 ));
 select * into service from public.appointment_services
 where organization_id = p_organization_id and id = p_service_id for update;
 if not found then raise exception 'Appointment service not found' using errcode = 'P0002'; end if;
 if service.resource_version <> p_expected_version then
  raise exception 'Service resource requirements changed' using errcode = 'P0001';
 end if;
 delete from public.appointment_service_resource_requirements
 where organization_id = p_organization_id and service_id = p_service_id;
 for item in select value from jsonb_array_elements(p_requirements) loop
  if jsonb_typeof(item) <> 'object' or not (item ?& array['kind', 'quantity'])
   or (item - array['kind', 'quantity']) <> '{}'::jsonb then
   raise exception 'Invalid resource requirement item' using errcode = '22023';
  end if;
  begin
   kind_value := item ->> 'kind'; quantity_value := (item ->> 'quantity')::smallint;
  exception when others then
   raise exception 'Invalid resource requirement value' using errcode = '22023';
  end;
  if kind_value not in ('room', 'equipment') or quantity_value not between 1 and 10 then
   raise exception 'Invalid resource requirement value' using errcode = '22023';
  end if;
  insert into public.appointment_service_resource_requirements(
   organization_id, service_id, kind, quantity, created_by
  ) values (p_organization_id, p_service_id, kind_value, quantity_value, auth.uid());
 end loop;
 if exists (
  select 1 from public.appointments appointment
  join public.appointment_service_resource_requirements requirement
   on requirement.organization_id = appointment.organization_id
   and requirement.service_id = appointment.service_id
  where appointment.organization_id = p_organization_id
   and appointment.service_id = p_service_id
   and appointment.status in ('reserved', 'confirmed', 'checked_in')
   and requirement.quantity > (
    select count(*) from public.appointment_resources resource
    where resource.organization_id = appointment.organization_id
     and resource.id = any(appointment.resource_ids) and resource.is_active
     and resource.kind = requirement.kind
   )
 ) then
  raise exception 'Requirements exclude an active appointment' using errcode = 'P0001';
 end if;
 update public.appointment_services set resource_version = resource_version + 1
 where organization_id = p_organization_id and id = p_service_id returning * into service;
 select jsonb_build_object(
  'service_id', service.id, 'resource_version', service.resource_version,
  'requirements', coalesce(jsonb_agg(jsonb_build_object(
   'kind', requirement.kind, 'quantity', requirement.quantity
  ) order by requirement.kind), '[]'::jsonb)
 ) into result
 from public.appointment_service_resource_requirements requirement
 where requirement.organization_id = p_organization_id and requirement.service_id = p_service_id;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, result);
 return result;
end $$;
revoke all on function public.replace_appointment_service_resource_requirements(uuid, uuid, jsonb, bigint, uuid)
 from public, anon;
grant execute on function public.replace_appointment_service_resource_requirements(uuid, uuid, jsonb, bigint, uuid)
 to authenticated;

create function public.save_appointment_with_resources(
 p_organization_id uuid, p_appointment_id uuid, p_customer_id uuid, p_staff_id uuid,
 p_service_id uuid, p_start_at timestamptz, p_source text, p_expected_version bigint,
 p_operation_id uuid, p_resource_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_value public.appointments%rowtype; service public.appointment_services%rowtype;
 prior public.appointment_operations%rowtype; fingerprint text; next_end timestamptz;
 old_staff uuid; lock_resource uuid;
begin
 perform private.assert_appointment_role(p_organization_id, false);
 if p_customer_id is null or p_staff_id is null or p_service_id is null or p_start_at is null
  or p_operation_id is null or p_source is null or p_source not in ('manual','phone','walk_in','online')
  or p_resource_ids is null or cardinality(p_resource_ids) > 20
  or (p_appointment_id is null and p_expected_version is not null)
  or (p_appointment_id is not null and (p_expected_version is null or p_expected_version < 1)) then
  raise exception 'Invalid appointment' using errcode = '22023';
 end if;
 fingerprint := md5(jsonb_build_object(
  'id', p_appointment_id, 'customer', p_customer_id, 'staff', p_staff_id,
  'service', p_service_id, 'start', p_start_at, 'source', p_source,
  'version', p_expected_version, 'resources', p_resource_ids
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
 if not exists (select 1 from public.customers where id = p_customer_id
  and organization_id = p_organization_id and status not in ('blocked','inactive')) then
  raise exception 'Active customer not found' using errcode = 'P0002';
 end if;
 if not exists (select 1 from public.appointment_staff where id = p_staff_id
  and organization_id = p_organization_id and is_active) then
  raise exception 'Active staff not found' using errcode = 'P0002';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(
  'appointment-service:' || p_organization_id::text || p_service_id::text, 0
 ));
 select * into service from public.appointment_services
 where id = p_service_id and organization_id = p_organization_id and is_active;
 if not found then raise exception 'Active service not found' using errcode = 'P0002'; end if;
 next_end := p_start_at + make_interval(mins => service.duration_minutes);
 if p_appointment_id is not null then
  select * into row_value from public.appointments
  where organization_id = p_organization_id and id = p_appointment_id for update;
  if not found then raise exception 'Appointment not found' using errcode = 'P0002'; end if;
  if row_value.version <> p_expected_version or row_value.status not in ('reserved','confirmed')
   or row_value.customer_id <> p_customer_id then
   raise exception 'Appointment changed' using errcode = 'P0001';
  end if;
  old_staff := row_value.staff_id;
 end if;
 if old_staff is not null and old_staff <> p_staff_id then
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:' || p_organization_id::text || least(old_staff,p_staff_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:' || p_organization_id::text || greatest(old_staff,p_staff_id)::text,0));
 else
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:' || p_organization_id::text || p_staff_id::text,0));
 end if;
 for lock_resource in
  select distinct resource_id from unnest(
   p_resource_ids || coalesce(row_value.resource_ids, '{}'::uuid[])
  ) resource_id order by resource_id
 loop
  perform pg_advisory_xact_lock(hashtextextended(
   'appointment-resource:' || p_organization_id::text || lock_resource::text, 0
  ));
 end loop;
 if exists (select 1 from public.appointments appointment
  where appointment.organization_id = p_organization_id and appointment.staff_id = p_staff_id
   and appointment.id is distinct from p_appointment_id
   and appointment.status in ('reserved','confirmed','checked_in')
   and appointment.start_at < next_end + make_interval(mins => service.buffer_minutes)
   and p_start_at < appointment.end_at + make_interval(mins => appointment.buffer_minutes)) then
  raise exception 'Staff slot conflict' using errcode = 'P0001';
 end if;
 if p_appointment_id is null then
  insert into public.appointments(
   organization_id, customer_id, staff_id, service_id, service_name_snapshot,
   duration_minutes, buffer_minutes, start_at, end_at, source, resource_ids,
   created_by, updated_by
  ) values (
   p_organization_id, p_customer_id, p_staff_id, p_service_id, service.name,
   service.duration_minutes, service.buffer_minutes, p_start_at, next_end, p_source,
   p_resource_ids, auth.uid(), auth.uid()
  ) returning * into row_value;
 else
  update public.appointments set staff_id = p_staff_id, service_id = p_service_id,
   service_name_snapshot = service.name, duration_minutes = service.duration_minutes,
   buffer_minutes = service.buffer_minutes, start_at = p_start_at, end_at = next_end,
   source = p_source, resource_ids = p_resource_ids, version = version + 1,
   updated_by = auth.uid(), updated_at = now()
  where id = p_appointment_id returning * into row_value;
 end if;
 insert into public.appointment_operations(
  organization_id, operation_id, actor_id, fingerprint, result_snapshot
 ) values (p_organization_id, p_operation_id, auth.uid(), fingerprint, to_jsonb(row_value));
 return to_jsonb(row_value);
end $$;
revoke all on function public.save_appointment_with_resources(
 uuid, uuid, uuid, uuid, uuid, timestamptz, text, bigint, uuid, uuid[]
) from public, anon;
grant execute on function public.save_appointment_with_resources(
 uuid, uuid, uuid, uuid, uuid, timestamptz, text, bigint, uuid, uuid[]
) to authenticated;

-- Keep older clients on the same locking and validation path. Existing resources
-- are preserved for edits; new appointments without requirements may still use it.
create or replace function public.save_appointment(
 p_organization_id uuid, p_appointment_id uuid, p_customer_id uuid, p_staff_id uuid,
 p_service_id uuid, p_start_at timestamptz, p_source text, p_expected_version bigint,
 p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare selected_resources uuid[] := '{}'::uuid[];
begin
 if p_appointment_id is not null then
  select resource_ids into selected_resources
  from public.appointments
  where organization_id = p_organization_id and id = p_appointment_id;
 end if;
 return public.save_appointment_with_resources(
  p_organization_id, p_appointment_id, p_customer_id, p_staff_id, p_service_id,
  p_start_at, p_source, p_expected_version, p_operation_id,
  coalesce(selected_resources, '{}'::uuid[])
 );
end $$;
revoke all on function public.save_appointment(
 uuid, uuid, uuid, uuid, uuid, timestamptz, text, bigint, uuid
) from public, anon;
grant execute on function public.save_appointment(
 uuid, uuid, uuid, uuid, uuid, timestamptz, text, bigint, uuid
) to authenticated;

commit;
