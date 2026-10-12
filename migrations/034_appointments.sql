-- APT-001..004: organization-scoped appointment slots and visit handoff.
begin;

create table public.appointment_staff (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 name text not null check(length(btrim(name)) between 1 and 120),
 is_active boolean not null default true,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(organization_id,id)
);
create table public.appointment_services (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 name text not null check(length(btrim(name)) between 1 and 160),
 duration_minutes int not null check(duration_minutes between 5 and 480),
 buffer_minutes int not null default 0 check(buffer_minutes between 0 and 120),
 is_active boolean not null default true,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(organization_id,id)
);
create table public.appointments (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 customer_id uuid not null,
 staff_id uuid not null,
 service_id uuid not null,
 service_name_snapshot text not null,
 duration_minutes int not null check(duration_minutes between 5 and 480),
 buffer_minutes int not null check(buffer_minutes between 0 and 120),
 start_at timestamptz not null,
 end_at timestamptz not null,
 status text not null default 'reserved' check(status in ('reserved','confirmed','checked_in','completed','canceled','no_show')),
 source text not null default 'manual' check(source in ('manual','phone','walk_in','online')),
 cancellation_reason text,
 version bigint not null default 1 check(version>0),
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id),
 foreign key(staff_id,organization_id) references public.appointment_staff(id,organization_id),
 foreign key(service_id,organization_id) references public.appointment_services(id,organization_id),
 check(end_at>start_at),
 check((status='canceled')=(cancellation_reason is not null))
);
create index appointments_staff_time on public.appointments(organization_id,staff_id,start_at,end_at)
 where status in ('reserved','confirmed','checked_in');
create index appointments_org_time on public.appointments(organization_id,start_at);
create index appointments_customer_time on public.appointments(organization_id,customer_id,start_at desc);
create table public.appointment_operations (
 organization_id uuid not null references public.organizations(id),
 operation_id uuid not null,
 actor_id uuid not null references auth.users(id),
 fingerprint text not null,
 result_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,operation_id)
);

do $$ declare t text; begin
 foreach t in array array['appointment_staff','appointment_services','appointments','appointment_operations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy appointment_member_read on public.%I for select to authenticated using ((select private.has_organization_role(organization_id,array[''owner'',''admin'',''member'']::text[])))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function private.assert_appointment_role(p_organization_id uuid,p_manager boolean)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or p_organization_id is null or not private.has_organization_role(
  p_organization_id,case when p_manager then array['owner','admin']::text[]
  else array['owner','admin','member']::text[] end) then
  raise exception 'Appointment permission required' using errcode='42501';
 end if;
end $$;
revoke all on function private.assert_appointment_role(uuid,boolean) from public,anon,authenticated;

create function public.create_appointment_staff(p_organization_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointment_staff%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_name is null or length(btrim(p_name)) not between 1 and 120 then
  raise exception 'Invalid staff name' using errcode='22023'; end if;
 insert into public.appointment_staff(organization_id,name,created_by)
 values(p_organization_id,btrim(p_name),auth.uid()) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.create_appointment_staff(uuid,text) from public,anon;
grant execute on function public.create_appointment_staff(uuid,text) to authenticated;

create function public.create_appointment_service(p_organization_id uuid,p_name text,p_duration_minutes int,p_buffer_minutes int)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointment_services%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_name is null or length(btrim(p_name)) not between 1 and 160 or p_duration_minutes not between 5 and 480
  or p_buffer_minutes not between 0 and 120 then
  raise exception 'Invalid service' using errcode='22023'; end if;
 insert into public.appointment_services(organization_id,name,duration_minutes,buffer_minutes,created_by)
 values(p_organization_id,btrim(p_name),p_duration_minutes,p_buffer_minutes,auth.uid()) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.create_appointment_service(uuid,text,int,int) from public,anon;
grant execute on function public.create_appointment_service(uuid,text,int,int) to authenticated;

create function public.save_appointment(
 p_organization_id uuid,p_appointment_id uuid,p_customer_id uuid,p_staff_id uuid,p_service_id uuid,
 p_start_at timestamptz,p_source text,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointments%rowtype; s public.appointment_services%rowtype;
 fp text; prior public.appointment_operations%rowtype; next_end timestamptz; old_staff uuid;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_customer_id is null or p_staff_id is null or p_service_id is null or p_start_at is null
  or p_operation_id is null or p_source is null or p_source not in ('manual','phone','walk_in','online')
  or (p_appointment_id is null and p_expected_version is not null)
  or (p_appointment_id is not null and (p_expected_version is null or p_expected_version<1)) then
  raise exception 'Invalid appointment' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('id',p_appointment_id,'customer',p_customer_id,'staff',p_staff_id,
  'service',p_service_id,'start',p_start_at,'source',p_source,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 if not exists(select 1 from public.customers where id=p_customer_id and organization_id=p_organization_id
  and status not in ('blocked','inactive')) then raise exception 'Active customer not found' using errcode='P0002'; end if;
 if not exists(select 1 from public.appointment_staff where id=p_staff_id and organization_id=p_organization_id and is_active)
  then raise exception 'Active staff not found' using errcode='P0002'; end if;
 select * into s from public.appointment_services where id=p_service_id and organization_id=p_organization_id and is_active;
 if not found then raise exception 'Active service not found' using errcode='P0002'; end if;
 next_end=p_start_at+make_interval(mins=>s.duration_minutes);
 if p_appointment_id is not null then
  select * into r from public.appointments where organization_id=p_organization_id and id=p_appointment_id for update;
  if not found then raise exception 'Appointment not found' using errcode='P0002'; end if;
  if r.version<>p_expected_version or r.status not in ('reserved','confirmed') or r.customer_id<>p_customer_id then
   raise exception 'Appointment changed' using errcode='P0001'; end if;
  old_staff=r.staff_id;
 end if;
 -- A staff lock serializes both start and end changes; same-staff concurrent inserts cannot pass the probe together.
 if old_staff is not null and old_staff<>p_staff_id then
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||least(old_staff,p_staff_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||greatest(old_staff,p_staff_id)::text,0));
 else
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||p_staff_id::text,0));
 end if;
 if exists(select 1 from public.appointments a where a.organization_id=p_organization_id and a.staff_id=p_staff_id
  and a.id is distinct from p_appointment_id and a.status in ('reserved','confirmed','checked_in')
  and a.start_at<next_end+make_interval(mins=>s.buffer_minutes)
  and p_start_at<a.end_at+make_interval(mins=>a.buffer_minutes)) then
  raise exception 'Staff slot conflict' using errcode='P0001'; end if;
 if p_appointment_id is null then
  insert into public.appointments(organization_id,customer_id,staff_id,service_id,service_name_snapshot,
   duration_minutes,buffer_minutes,start_at,end_at,source,created_by,updated_by)
  values(p_organization_id,p_customer_id,p_staff_id,p_service_id,s.name,s.duration_minutes,s.buffer_minutes,
   p_start_at,next_end,p_source,auth.uid(),auth.uid()) returning * into r;
 else
  update public.appointments set staff_id=p_staff_id,service_id=p_service_id,service_name_snapshot=s.name,
   duration_minutes=s.duration_minutes,buffer_minutes=s.buffer_minutes,start_at=p_start_at,end_at=next_end,
   source=p_source,version=version+1,updated_by=auth.uid(),updated_at=now()
  where id=p_appointment_id returning * into r;
 end if;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.save_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz,text,bigint,uuid) from public,anon;
grant execute on function public.save_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz,text,bigint,uuid) to authenticated;

create function public.transition_appointment(
 p_organization_id uuid,p_appointment_id uuid,p_target_status text,p_reason text,
 p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointments%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_appointment_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_target_status is null or p_target_status not in ('confirmed','checked_in','completed','canceled','no_show')
  or (p_target_status='canceled' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000)) then
  raise exception 'Invalid transition' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('id',p_appointment_id,'status',p_target_status,'reason',p_reason,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into r from public.appointments where organization_id=p_organization_id and id=p_appointment_id for update;
 if not found then raise exception 'Appointment not found' using errcode='P0002'; end if;
 if r.version<>p_expected_version or not ((r.status='reserved' and p_target_status in ('confirmed','checked_in','canceled','no_show'))
  or (r.status='confirmed' and p_target_status in ('checked_in','canceled','no_show'))
  or (r.status='checked_in' and p_target_status='completed')) then
  raise exception 'Appointment state conflict' using errcode='P0001'; end if;
 if p_target_status='checked_in' and not exists(select 1 from public.customer_visits where organization_id=p_organization_id and appointment_id=r.id) then
  with visit as (
   insert into public.customer_visits(organization_id,customer_id,appointment_id,created_by,updated_by)
   values(p_organization_id,r.customer_id,r.id,auth.uid(),auth.uid()) returning id,organization_id,customer_id
  ) insert into public.sale_carts(organization_id,visit_id,customer_id,created_by,updated_by)
   select organization_id,id,customer_id,auth.uid(),auth.uid() from visit;
 end if;
 update public.appointments set status=p_target_status,
  cancellation_reason=case when p_target_status='canceled' then btrim(p_reason) else null end,
  version=version+1,updated_by=auth.uid(),updated_at=now()
 where id=r.id returning * into r;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) from public,anon;
grant execute on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) to authenticated;

create unique index customer_visits_appointment_once on public.customer_visits(organization_id,appointment_id)
 where appointment_id is not null;
alter table public.customer_visits add constraint customer_visits_scoped_appointment
 foreign key(organization_id,appointment_id) references public.appointments(organization_id,id);
commit;
