-- N1030-09 / APT multi-service visits. Each ordered service segment remains a
-- regular appointment row so existing staff/resource occupancy checks stay authoritative.
begin;

create table if not exists public.appointment_visit_groups (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 customer_id uuid not null,
 branch_id uuid not null,
 status text not null default 'active' check(status in ('active','replacing','transitioning','canceling','canceled','completed','no_show')),
 version bigint not null default 1 check(version>0),
 created_by uuid not null references auth.users(id),
 updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 canceled_by uuid,
 canceled_at timestamptz,
 unique(organization_id,id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id),
 foreign key(organization_id,branch_id) references public.organization_branches(organization_id,id),
 check((status='canceled')=(canceled_at is not null))
);

alter table public.appointments add column if not exists visit_group_id uuid;
alter table public.appointments add column if not exists visit_order smallint;
alter table public.appointments add column if not exists visit_group_version bigint;
alter table public.appointments add column if not exists is_current boolean not null default true;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='appointments_visit_group_fk') then
  alter table public.appointments add constraint appointments_visit_group_fk
   foreign key(organization_id,visit_group_id) references public.appointment_visit_groups(organization_id,id);
 end if;
 if not exists(select 1 from pg_constraint where conname='appointments_visit_group_pair_check') then
  alter table public.appointments add constraint appointments_visit_group_pair_check
   check((visit_group_id is null)=(visit_order is null) and (visit_order is null or visit_order between 1 and 8)
    and (visit_group_id is null)=(visit_group_version is null));
 end if;
end $$;
create index if not exists appointments_visit_group_order on public.appointments(organization_id,visit_group_id,visit_order)
 where visit_group_id is not null;
create index if not exists appointments_visit_group_current on public.appointments(organization_id,visit_group_id,visit_order)
 where visit_group_id is not null and is_current;

alter table public.appointment_visit_groups enable row level security;
revoke all on public.appointment_visit_groups from public,anon,authenticated;

create or replace function private.guard_appointment_visit_group_cancel()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.visit_group_id is not null and old.status is distinct from new.status
  and exists(select 1 from public.appointment_visit_groups g where g.organization_id=old.organization_id
   and g.id=old.visit_group_id and g.status='active') then
  raise exception 'Transition the complete visit group' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function private.guard_appointment_visit_group_cancel() from public,anon,authenticated;
drop trigger if exists appointments_visit_group_cancel_guard on public.appointments;
create trigger appointments_visit_group_cancel_guard before update of status on public.appointments
 for each row execute function private.guard_appointment_visit_group_cancel();

-- Every segment is a distinct schedule row, but check-in produces one customer visit/cart per group.
create or replace function public.transition_appointment(
 p_organization_id uuid,p_appointment_id uuid,p_target_status text,p_reason text,
 p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointments%rowtype; prior public.appointment_operations%rowtype;
 fp text; old_status text; group_id uuid;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_appointment_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_target_status is null or p_target_status not in ('confirmed','checked_in','completed','canceled','no_show')
  or (p_target_status='canceled' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000)) then
  raise exception 'Invalid transition' using errcode='22023';end if;
 fp:=md5(jsonb_build_object('id',p_appointment_id,'status',p_target_status,'reason',p_reason,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 if p_target_status='no_show' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000) then raise exception 'No-show reason required' using errcode='22023';end if;
 select * into r from public.appointments where organization_id=p_organization_id and id=p_appointment_id for update;
 if not found then raise exception 'Appointment not found' using errcode='P0002';end if;
 group_id:=r.visit_group_id;
 if group_id is not null and p_target_status='checked_in' then
  perform pg_advisory_xact_lock(hashtextextended('appointment-visit-group:'||p_organization_id::text||group_id::text,0));
  if not exists(select 1 from public.customer_visits where organization_id=p_organization_id and appointment_id=r.id)
   and not exists(select 1 from public.customer_visits v join public.appointments a on a.organization_id=v.organization_id and a.id=v.appointment_id
    where a.organization_id=p_organization_id and a.visit_group_id=group_id) then
   with visit as (
    insert into public.customer_visits(organization_id,customer_id,appointment_id,created_by,updated_by)
    values(p_organization_id,r.customer_id,r.id,auth.uid(),auth.uid()) returning id,organization_id,customer_id
   ) insert into public.sale_carts(organization_id,visit_id,customer_id,created_by,updated_by)
    select organization_id,id,customer_id,auth.uid(),auth.uid() from visit;
  end if;
 elsif p_target_status='checked_in' and not exists(select 1 from public.customer_visits where organization_id=p_organization_id and appointment_id=r.id) then
  with visit as (
   insert into public.customer_visits(organization_id,customer_id,appointment_id,created_by,updated_by)
   values(p_organization_id,r.customer_id,r.id,auth.uid(),auth.uid()) returning id,organization_id,customer_id
  ) insert into public.sale_carts(organization_id,visit_id,customer_id,created_by,updated_by)
   select organization_id,id,customer_id,auth.uid(),auth.uid() from visit;
 end if;
 if r.version<>p_expected_version or not ((r.status='reserved' and p_target_status in ('confirmed','checked_in','canceled','no_show'))
  or (r.status='confirmed' and p_target_status in ('checked_in','canceled','no_show'))
  or (r.status='checked_in' and p_target_status='completed')) then raise exception 'Appointment state conflict' using errcode='P0001';end if;
 old_status:=r.status;
 update public.appointments set status=p_target_status,
  cancellation_reason=case when p_target_status='canceled' then btrim(p_reason) else null end,
  no_show_reason=case when p_target_status='no_show' then btrim(p_reason) else null end,
  version=version+1,updated_by=auth.uid(),updated_at=now()
 where organization_id=p_organization_id and id=r.id returning * into r;
 insert into public.appointment_status_events(organization_id,appointment_id,appointment_version,previous_status,next_status,reason,actor_id,operation_id)
 values(p_organization_id,r.id,r.version,old_status,r.status,case when r.status in ('canceled','no_show') then btrim(p_reason) else null end,auth.uid(),p_operation_id);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) from public,anon;
grant execute on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) to authenticated;

create or replace function private.guard_appointment_visit_group_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.visit_group_id is not null and old.is_current
  and (new.staff_id,new.service_id,new.start_at,new.end_at,new.buffer_minutes,new.resource_ids)
   is distinct from (old.staff_id,old.service_id,old.start_at,old.end_at,old.buffer_minutes,old.resource_ids)
  and exists(select 1 from public.appointment_visit_groups g where g.organization_id=old.organization_id
   and g.id=old.visit_group_id and g.status='active') then
  raise exception 'Edit the complete visit group' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function private.guard_appointment_visit_group_update() from public,anon,authenticated;
drop trigger if exists appointments_visit_group_update_guard on public.appointments;
create trigger appointments_visit_group_update_guard before update of staff_id,service_id,start_at,end_at,buffer_minutes,resource_ids
 on public.appointments for each row execute function private.guard_appointment_visit_group_update();

create or replace function public.create_appointment_visit_group(
 p_organization_id uuid,p_customer_id uuid,p_start_at timestamptz,p_source text,
 p_items jsonb,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=(select auth.uid()); fp text; prior public.appointment_operations%rowtype;
 group_id uuid; item jsonb; ordinal integer:=0; v_service_id uuid; v_staff_id uuid; resource_ids uuid[]; group_branch uuid; staff_branch uuid;
 service_row public.appointment_services%rowtype; cursor_at timestamptz:=p_start_at;
 nested_operation uuid; saved jsonb; created jsonb:='[]'::jsonb; result_value jsonb; selected text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if caller is null or p_customer_id is null or p_start_at is null or p_operation_id is null
  or p_source is null or p_source not in ('manual','phone','walk_in','online')
  or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 2 and 8 then
  raise exception 'Invalid appointment visit group' using errcode='22023';
 end if;
 if exists(select 1 from jsonb_array_elements(p_items) i(value)
  where jsonb_typeof(value)<>'object' or value-array['service_id','staff_id','resource_ids']<>'{}'::jsonb
   or not(value ?& array['service_id','staff_id','resource_ids'])
   or jsonb_typeof(value->'service_id')<>'string' or jsonb_typeof(value->'staff_id')<>'string'
   or jsonb_typeof(value->'resource_ids')<>'array' or jsonb_array_length(value->'resource_ids')>20) then
  raise exception 'Invalid visit service segment' using errcode='22023';
 end if;
 begin
  perform (value->>'service_id')::uuid from jsonb_array_elements(p_items) x(value);
  perform (value->>'staff_id')::uuid from jsonb_array_elements(p_items) x(value);
  perform resource.value::uuid from jsonb_array_elements(p_items) x(value),jsonb_array_elements_text(value->'resource_ids') resource(value);
 exception when others then raise exception 'Invalid visit service identifier' using errcode='22023'; end;
 fp:=md5(jsonb_build_object('kind','visit_group_create','customer',p_customer_id,'start',p_start_at,'source',p_source,'items',p_items)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>caller or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 -- Stable global lock ordering prevents bundle-vs-single save deadlocks.
 for selected in select distinct value->>'service_id' from jsonb_array_elements(p_items) x(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-service:'||p_organization_id::text||selected,0));
 end loop;
 for selected in select distinct value->>'staff_id' from jsonb_array_elements(p_items) x(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||selected,0));
 end loop;
 for selected in select distinct resource.value from jsonb_array_elements(p_items) x(value),jsonb_array_elements_text(value->'resource_ids') resource(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-resource:'||p_organization_id::text||selected,0));
 end loop;
 if not exists(select 1 from public.customers c where c.organization_id=p_organization_id and c.id=p_customer_id and c.status not in ('blocked','inactive')) then
  raise exception 'Active customer not found' using errcode='P0002'; end if;
 for item in select value from jsonb_array_elements(p_items) loop
  select branch_id into staff_branch from public.appointment_staff where organization_id=p_organization_id and id=(item->>'staff_id')::uuid and is_active;
  if not found then raise exception 'Active staff not found' using errcode='P0002';end if;
  if group_branch is null then group_branch:=staff_branch;elsif group_branch<>staff_branch then raise exception 'Visit group cannot cross branches' using errcode='22023';end if;
 end loop;
 insert into public.appointment_visit_groups(organization_id,customer_id,branch_id,created_by,updated_by)
 values(p_organization_id,p_customer_id,group_branch,caller,caller) returning id into group_id;
 for item in select value from jsonb_array_elements(p_items) loop
  ordinal:=ordinal+1;v_service_id:=(item->>'service_id')::uuid;v_staff_id:=(item->>'staff_id')::uuid;
  select * into service_row from public.appointment_services where organization_id=p_organization_id and id=v_service_id and is_active;
  if not found then raise exception 'Active service not found' using errcode='P0002'; end if;
  if exists(select 1 from public.appointment_service_staff m where m.organization_id=p_organization_id and m.service_id=v_service_id)
   and not exists(select 1 from public.appointment_service_staff m where m.organization_id=p_organization_id and m.service_id=v_service_id and m.staff_id=v_staff_id) then
   raise exception 'Staff cannot perform this service' using errcode='22023';end if;
  resource_ids:=array(select value::uuid from jsonb_array_elements_text(item->'resource_ids'));
  if cardinality(resource_ids)<> (select count(distinct value) from unnest(resource_ids) value) then
   raise exception 'Duplicate appointment resource' using errcode='22023'; end if;
  nested_operation:=(substr(md5(p_operation_id::text||':'||ordinal),1,8)||'-'||substr(md5(p_operation_id::text||':'||ordinal),9,4)||'-'||substr(md5(p_operation_id::text||':'||ordinal),13,4)||'-'||substr(md5(p_operation_id::text||':'||ordinal),17,4)||'-'||substr(md5(p_operation_id::text||':'||ordinal),21,12))::uuid;
  saved:=public.save_appointment_with_resources(p_organization_id,null,p_customer_id,v_staff_id,v_service_id,cursor_at,p_source,null,nested_operation,resource_ids);
  update public.appointments set visit_group_id=group_id,visit_order=ordinal,visit_group_version=1
   where organization_id=p_organization_id and id=(saved->>'id')::uuid returning to_jsonb(appointments.*) into saved;
  created:=created||jsonb_build_array(saved);
  cursor_at:=cursor_at+make_interval(mins=>service_row.duration_minutes+service_row.buffer_minutes);
 end loop;
 result_value:=jsonb_build_object('visit_group_id',group_id,'organization_id',p_organization_id,'customer_id',p_customer_id,'branch_id',group_branch,
  'version',1,'status','active','created',created,'replayed',false);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,caller,fp,result_value);
 return result_value;
end $$;
revoke all on function public.create_appointment_visit_group(uuid,uuid,timestamptz,text,jsonb,uuid) from public,anon;
grant execute on function public.create_appointment_visit_group(uuid,uuid,timestamptz,text,jsonb,uuid) to authenticated;

create or replace function public.cancel_appointment_visit_group(
 p_organization_id uuid,p_visit_group_id uuid,p_expected_version bigint,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=(select auth.uid()); group_row public.appointment_visit_groups%rowtype;
 prior public.appointment_operations%rowtype; fp text; appointment_row public.appointments%rowtype;
 nested_operation uuid; canceled jsonb:='[]'::jsonb; result_value jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if caller is null or p_visit_group_id is null or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then
  raise exception 'Invalid visit group cancellation' using errcode='22023'; end if;
 fp:=md5(jsonb_build_object('kind','visit_group_cancel','id',p_visit_group_id,'version',p_expected_version,'reason',btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>caller or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into group_row from public.appointment_visit_groups where organization_id=p_organization_id and id=p_visit_group_id for update;
 if not found then raise exception 'Visit group not found' using errcode='P0002'; end if;
 if group_row.version<>p_expected_version or group_row.status<>'active' then raise exception 'Visit group changed' using errcode='P0001'; end if;
 if exists(select 1 from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current and status not in ('reserved','confirmed')) then
  raise exception 'Checked-in or completed visit cannot be canceled as a group' using errcode='P0001'; end if;
 update public.appointment_visit_groups set status='canceling' where organization_id=p_organization_id and id=p_visit_group_id;
 for appointment_row in select * from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and status in ('reserved','confirmed') order by visit_order for update loop
  nested_operation:=(substr(md5(p_operation_id::text||':'||appointment_row.id::text),1,8)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),9,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),13,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),17,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),21,12))::uuid;
  canceled:=canceled||jsonb_build_array(public.transition_appointment(p_organization_id,appointment_row.id,'canceled',btrim(p_reason),appointment_row.version,nested_operation));
 end loop;
 update public.appointment_visit_groups set status='canceled',version=version+1,canceled_by=caller,canceled_at=now(),updated_by=caller,updated_at=now()
 where organization_id=p_organization_id and id=p_visit_group_id returning to_jsonb(appointment_visit_groups.*) into result_value;
 update public.appointments set visit_group_version=(result_value->>'version')::bigint
  where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.visit_order),'[]'::jsonb) into canceled from public.appointments a
  where a.organization_id=p_organization_id and a.visit_group_id=p_visit_group_id and a.is_current;
 result_value:=result_value||jsonb_build_object('canceled',canceled,'replayed',false);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,caller,fp,result_value);
 return result_value;
end $$;
revoke all on function public.cancel_appointment_visit_group(uuid,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.cancel_appointment_visit_group(uuid,uuid,bigint,text,uuid) to authenticated;

create or replace function public.replace_appointment_visit_group(
 p_organization_id uuid,p_visit_group_id uuid,p_expected_version bigint,p_start_at timestamptz,
 p_source text,p_items jsonb,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=(select auth.uid()); group_row public.appointment_visit_groups%rowtype; fp text; staff_branch uuid;
 prior public.appointment_operations%rowtype; old_row public.appointments%rowtype; item jsonb;
 ordinal integer:=0; v_service_id uuid; v_staff_id uuid; resource_ids uuid[]; service_row public.appointment_services%rowtype;
 cursor_at timestamptz:=p_start_at; nested_operation uuid; saved jsonb; canceled jsonb:='[]'::jsonb; created jsonb:='[]'::jsonb;
 result_value jsonb; selected text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if caller is null or p_visit_group_id is null or p_expected_version is null or p_expected_version<1
  or p_start_at is null or p_operation_id is null or p_source is null or p_source not in ('manual','phone','walk_in','online')
  or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 2 and 8 then
  raise exception 'Invalid appointment visit replacement' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) i(value)
  where jsonb_typeof(value)<>'object' or value-array['service_id','staff_id','resource_ids']<>'{}'::jsonb
   or not(value ?& array['service_id','staff_id','resource_ids'])
   or jsonb_typeof(value->'service_id')<>'string' or jsonb_typeof(value->'staff_id')<>'string'
   or jsonb_typeof(value->'resource_ids')<>'array' or jsonb_array_length(value->'resource_ids')>20) then
  raise exception 'Invalid visit service segment' using errcode='22023'; end if;
 begin
  perform (value->>'service_id')::uuid from jsonb_array_elements(p_items) x(value);
  perform (value->>'staff_id')::uuid from jsonb_array_elements(p_items) x(value);
  perform resource.value::uuid from jsonb_array_elements(p_items) x(value),jsonb_array_elements_text(value->'resource_ids') resource(value);
 exception when others then raise exception 'Invalid visit service identifier' using errcode='22023'; end;
 fp:=md5(jsonb_build_object('kind','visit_group_replace','id',p_visit_group_id,'version',p_expected_version,'start',p_start_at,'source',p_source,'items',p_items)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>caller or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into group_row from public.appointment_visit_groups where organization_id=p_organization_id and id=p_visit_group_id for update;
 if not found then raise exception 'Visit group not found' using errcode='P0002';end if;
 if group_row.version<>p_expected_version or group_row.status<>'active' then raise exception 'Visit group changed' using errcode='P0001';end if;
 if exists(select 1 from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current and status not in ('reserved','confirmed')) then
  raise exception 'Checked-in or completed visit cannot be replaced' using errcode='P0001';end if;
 for selected in select distinct value->>'service_id' from jsonb_array_elements(p_items) x(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-service:'||p_organization_id::text||selected,0));
 end loop;
 for selected in select distinct value->>'staff_id' from jsonb_array_elements(p_items) x(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||selected,0));
 end loop;
 for selected in select distinct resource.value from jsonb_array_elements(p_items) x(value),jsonb_array_elements_text(value->'resource_ids') resource(value) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('appointment-resource:'||p_organization_id::text||selected,0));
 end loop;
 update public.appointment_visit_groups set status='replacing' where organization_id=p_organization_id and id=p_visit_group_id;
 for old_row in select * from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current order by visit_order for update loop
  nested_operation:=(substr(md5(p_operation_id::text||':old:'||old_row.id::text),1,8)||'-'||substr(md5(p_operation_id::text||':old:'||old_row.id::text),9,4)||'-'||substr(md5(p_operation_id::text||':old:'||old_row.id::text),13,4)||'-'||substr(md5(p_operation_id::text||':old:'||old_row.id::text),17,4)||'-'||substr(md5(p_operation_id::text||':old:'||old_row.id::text),21,12))::uuid;
  perform public.transition_appointment(p_organization_id,old_row.id,'canceled','예약 묶음 일괄 수정',old_row.version,nested_operation);
  update public.appointments set is_current=false where organization_id=p_organization_id and id=old_row.id returning to_jsonb(appointments.*) into saved;
  canceled:=canceled||jsonb_build_array(saved);
 end loop;
 for item in select value from jsonb_array_elements(p_items) loop
  ordinal:=ordinal+1;v_service_id:=(item->>'service_id')::uuid;v_staff_id:=(item->>'staff_id')::uuid;
  select * into service_row from public.appointment_services where organization_id=p_organization_id and id=v_service_id and is_active;
  if not found then raise exception 'Active service not found' using errcode='P0002';end if;
  select branch_id into staff_branch from public.appointment_staff where organization_id=p_organization_id and id=v_staff_id and is_active;
  if not found then raise exception 'Active staff not found' using errcode='P0002';end if;
  if staff_branch<>group_row.branch_id then raise exception 'Visit group cannot cross branches' using errcode='22023';end if;
  if exists(select 1 from public.appointment_service_staff m where m.organization_id=p_organization_id and m.service_id=v_service_id)
   and not exists(select 1 from public.appointment_service_staff m where m.organization_id=p_organization_id and m.service_id=v_service_id and m.staff_id=v_staff_id) then
   raise exception 'Staff cannot perform this service' using errcode='22023';end if;
  resource_ids:=array(select value::uuid from jsonb_array_elements_text(item->'resource_ids'));
  if cardinality(resource_ids)<>(select count(distinct value) from unnest(resource_ids) value) then raise exception 'Duplicate appointment resource' using errcode='22023';end if;
  nested_operation:=(substr(md5(p_operation_id::text||':new:'||ordinal),1,8)||'-'||substr(md5(p_operation_id::text||':new:'||ordinal),9,4)||'-'||substr(md5(p_operation_id::text||':new:'||ordinal),13,4)||'-'||substr(md5(p_operation_id::text||':new:'||ordinal),17,4)||'-'||substr(md5(p_operation_id::text||':new:'||ordinal),21,12))::uuid;
  saved:=public.save_appointment_with_resources(p_organization_id,null,group_row.customer_id,v_staff_id,v_service_id,cursor_at,p_source,null,nested_operation,resource_ids);
  update public.appointments set visit_group_id=p_visit_group_id,visit_order=ordinal,visit_group_version=p_expected_version+1
   where organization_id=p_organization_id and id=(saved->>'id')::uuid returning to_jsonb(appointments.*) into saved;
  created:=created||jsonb_build_array(saved);cursor_at:=cursor_at+make_interval(mins=>service_row.duration_minutes+service_row.buffer_minutes);
 end loop;
 update public.appointment_visit_groups set status='active',version=version+1,updated_by=caller,updated_at=now() where organization_id=p_organization_id and id=p_visit_group_id;
 result_value:=jsonb_build_object('id',p_visit_group_id,'organization_id',p_organization_id,'customer_id',group_row.customer_id,'branch_id',group_row.branch_id,'version',p_expected_version+1,'status','active','replaced',canceled,'created',created,'replayed',false);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,caller,fp,result_value);
 return result_value;
end $$;
revoke all on function public.replace_appointment_visit_group(uuid,uuid,bigint,timestamptz,text,jsonb,uuid) from public,anon;
grant execute on function public.replace_appointment_visit_group(uuid,uuid,bigint,timestamptz,text,jsonb,uuid) to authenticated;

create or replace function public.transition_appointment_visit_group(
 p_organization_id uuid,p_visit_group_id uuid,p_expected_version bigint,p_target_status text,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=(select auth.uid()); group_row public.appointment_visit_groups%rowtype; prior public.appointment_operations%rowtype;
 fp text; appointment_row public.appointments%rowtype; nested_operation uuid; updated jsonb:='[]'::jsonb; result_value jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if caller is null or p_visit_group_id is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null
  or p_target_status is null or p_target_status not in ('confirmed','checked_in','completed','no_show')
  or (p_target_status='no_show' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000))
  or (p_target_status<>'no_show' and p_reason is not null) then
  raise exception 'Invalid visit group transition' using errcode='22023';end if;
 fp:=md5(jsonb_build_object('kind','visit_group_transition','id',p_visit_group_id,'version',p_expected_version,'target',p_target_status,'reason',p_reason)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>caller or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into group_row from public.appointment_visit_groups where organization_id=p_organization_id and id=p_visit_group_id for update;
 if not found then raise exception 'Visit group not found' using errcode='P0002';end if;
 if group_row.version<>p_expected_version or group_row.status<>'active' then raise exception 'Visit group changed' using errcode='P0001';end if;
 if (p_target_status='confirmed' and exists(select 1 from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current and status<>'reserved'))
  or (p_target_status in ('checked_in','no_show') and exists(select 1 from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current and status not in ('reserved','confirmed')))
  or (p_target_status='completed' and exists(select 1 from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current and status<>'checked_in')) then
  raise exception 'Visit group state conflict' using errcode='P0001';end if;
 update public.appointment_visit_groups set status='transitioning' where organization_id=p_organization_id and id=p_visit_group_id;
 for appointment_row in select * from public.appointments where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current order by visit_order for update loop
  nested_operation:=(substr(md5(p_operation_id::text||':'||appointment_row.id::text),1,8)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),9,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),13,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),17,4)||'-'||substr(md5(p_operation_id::text||':'||appointment_row.id::text),21,12))::uuid;
  updated:=updated||jsonb_build_array(public.transition_appointment(p_organization_id,appointment_row.id,p_target_status,case when p_target_status='no_show' then btrim(p_reason) else null end,appointment_row.version,nested_operation));
 end loop;
 update public.appointment_visit_groups set status=case when p_target_status in ('completed','no_show') then p_target_status else 'active' end,
  version=version+1,updated_by=caller,updated_at=now() where organization_id=p_organization_id and id=p_visit_group_id returning to_jsonb(appointment_visit_groups.*) into result_value;
 update public.appointments set visit_group_version=(result_value->>'version')::bigint
  where organization_id=p_organization_id and visit_group_id=p_visit_group_id and is_current;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.visit_order),'[]'::jsonb) into updated from public.appointments a
  where a.organization_id=p_organization_id and a.visit_group_id=p_visit_group_id and a.is_current;
 result_value:=result_value||jsonb_build_object('updated',updated,'replayed',false);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,caller,fp,result_value);
 return result_value;
end $$;
revoke all on function public.transition_appointment_visit_group(uuid,uuid,bigint,text,text,uuid) from public,anon;
grant execute on function public.transition_appointment_visit_group(uuid,uuid,bigint,text,text,uuid) to authenticated;

commit;
