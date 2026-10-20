-- APT-13: retry-safe waitlist creation and atomic conversion to an appointment.
begin;

alter table public.appointment_waitlist
 add column if not exists operation_id uuid,
 add column if not exists operation_fingerprint text;
create unique index if not exists appointment_waitlist_operation_once
 on public.appointment_waitlist(organization_id,operation_id) where operation_id is not null;
revoke insert,update,delete on public.appointment_waitlist from authenticated;

create table if not exists public.appointment_waitlist_conversions (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 waitlist_id uuid not null,
 operation_id uuid not null,
 actor_id uuid not null references auth.users(id),
 fingerprint text not null,
 appointment_id uuid not null,
 result_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 primary key (organization_id,waitlist_id),
 unique (organization_id,operation_id),
 foreign key (organization_id,waitlist_id) references public.appointment_waitlist(organization_id,id) on delete cascade,
 foreign key (organization_id,appointment_id) references public.appointments(organization_id,id)
);
alter table public.appointment_waitlist_conversions enable row level security;
drop policy if exists appointment_waitlist_conversion_member_select on public.appointment_waitlist_conversions;
create policy appointment_waitlist_conversion_member_select on public.appointment_waitlist_conversions for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.appointment_waitlist_conversions from public,anon,authenticated;
grant select on public.appointment_waitlist_conversions to authenticated;

create or replace function public.create_appointment_waitlist(
 p_organization_id uuid,p_customer_id uuid,p_service_id uuid,p_staff_id uuid,
 p_preferred_date date,p_note text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointment_waitlist%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_operation_id is null or p_customer_id is null or p_service_id is null or length(coalesce(p_note,''))>1000 then
  raise exception 'Invalid waitlist request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('customer',p_customer_id,'service',p_service_id,'staff',p_staff_id,'date',p_preferred_date,'note',coalesce(p_note,''))::text);
 perform pg_advisory_xact_lock(hashtextextended('waitlist-create:'||p_organization_id::text||p_operation_id::text,0));
 select * into r from public.appointment_waitlist where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if r.created_by<>auth.uid() or r.operation_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return to_jsonb(r);
 end if;
 if not exists(select 1 from public.customers where id=p_customer_id and organization_id=p_organization_id and status not in ('blocked','inactive'))
  or not exists(select 1 from public.appointment_services where id=p_service_id and organization_id=p_organization_id and is_active)
  or (p_staff_id is not null and not exists(select 1 from public.appointment_staff where id=p_staff_id and organization_id=p_organization_id and is_active)) then
  raise exception 'Waitlist customer, service or staff unavailable' using errcode='P0002'; end if;
 insert into public.appointment_waitlist(organization_id,customer_id,service_id,staff_id,preferred_date,note,created_by,updated_by,operation_id,operation_fingerprint)
 values(p_organization_id,p_customer_id,p_service_id,p_staff_id,p_preferred_date,coalesce(p_note,''),auth.uid(),auth.uid(),p_operation_id,fp) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.create_appointment_waitlist(uuid,uuid,uuid,uuid,date,text,uuid) from public,anon;
grant execute on function public.create_appointment_waitlist(uuid,uuid,uuid,uuid,date,text,uuid) to authenticated;

create function public.update_appointment_waitlist_status(p_organization_id uuid,p_waitlist_id uuid,p_status text,p_expected_version bigint)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointment_waitlist%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_status not in ('waiting','contacted','canceled') or p_expected_version is null or p_expected_version<1 then raise exception 'Invalid waitlist status' using errcode='22023'; end if;
 update public.appointment_waitlist set status=p_status,version=version+1 where organization_id=p_organization_id and id=p_waitlist_id and version=p_expected_version returning * into r;
 if not found then
  if not exists(select 1 from public.appointment_waitlist where organization_id=p_organization_id and id=p_waitlist_id) then raise exception 'Waitlist entry not found' using errcode='P0002'; end if;
  raise exception 'Waitlist entry changed' using errcode='P0001';
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.update_appointment_waitlist_status(uuid,uuid,text,bigint) from public,anon;
grant execute on function public.update_appointment_waitlist_status(uuid,uuid,text,bigint) to authenticated;

create function public.book_appointment_from_waitlist(
 p_organization_id uuid,p_waitlist_id uuid,p_staff_id uuid,p_start_at timestamptz,
 p_resource_ids uuid[],p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.appointment_waitlist%rowtype; saved jsonb; snapshot jsonb; prior public.appointment_waitlist_conversions%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_waitlist_id is null or p_staff_id is null or p_start_at is null or p_resource_ids is null or cardinality(p_resource_ids)>20
  or p_expected_version is null or p_expected_version<1 or p_operation_id is null then
  raise exception 'Invalid waitlist booking' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('waitlist',p_waitlist_id,'staff',p_staff_id,'start',p_start_at,'resources',p_resource_ids,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('waitlist-book:'||p_organization_id::text||p_waitlist_id::text,0));
 select * into prior from public.appointment_waitlist_conversions where organization_id=p_organization_id and waitlist_id=p_waitlist_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.operation_id<>p_operation_id or prior.fingerprint<>fp then raise exception 'Waitlist already converted' using errcode='P0001'; end if;
  return prior.result_snapshot || jsonb_build_object('replayed',true);
 end if;
 select * into w from public.appointment_waitlist where organization_id=p_organization_id and id=p_waitlist_id for update;
 if not found then raise exception 'Waitlist entry not found' using errcode='P0002'; end if;
 if w.version<>p_expected_version or w.status not in ('waiting','contacted') then raise exception 'Waitlist entry changed' using errcode='P0001'; end if;
 saved=public.save_appointment_with_resources(p_organization_id,null,w.customer_id,p_staff_id,w.service_id,p_start_at,'manual',null,p_operation_id,p_resource_ids);
 update public.appointment_waitlist set status='booked',version=version+1,updated_by=auth.uid(),updated_at=now()
 where organization_id=p_organization_id and id=p_waitlist_id returning * into w;
 snapshot=jsonb_build_object('appointment',saved,'waitlist',to_jsonb(w));
 insert into public.appointment_waitlist_conversions(organization_id,waitlist_id,operation_id,actor_id,fingerprint,appointment_id,result_snapshot)
 values(p_organization_id,p_waitlist_id,p_operation_id,auth.uid(),fp,(saved->>'id')::uuid,snapshot);
 return snapshot||jsonb_build_object('replayed',false);
end $$;
revoke all on function public.book_appointment_from_waitlist(uuid,uuid,uuid,timestamptz,uuid[],bigint,uuid) from public,anon;
grant execute on function public.book_appointment_from_waitlist(uuid,uuid,uuid,timestamptz,uuid[],bigint,uuid) to authenticated;
commit;
