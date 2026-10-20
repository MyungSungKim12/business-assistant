-- APT-003/019 F13: 061 이후. 과거 상태 이력을 가공하거나 수수료를 생성하지 않는다.
begin;
alter table public.appointments add column if not exists no_show_reason text
 check(no_show_reason is null or (status='no_show' and length(btrim(no_show_reason)) between 1 and 1000));
create table if not exists public.appointment_status_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 appointment_id uuid not null,
 appointment_version bigint not null check(appointment_version>1),
 previous_status text not null,
 next_status text not null,
 reason text,
 actor_id uuid not null,
 operation_id uuid not null,
 occurred_at timestamptz not null default now(),
 unique(organization_id,operation_id),
 unique(organization_id,appointment_id,appointment_version),
 foreign key(organization_id,appointment_id) references public.appointments(organization_id,id),
 check((previous_status='reserved' and next_status in ('confirmed','checked_in','canceled','no_show'))
    or (previous_status='confirmed' and next_status in ('checked_in','canceled','no_show'))
    or (previous_status='checked_in' and next_status='completed')),
 check(case when next_status in ('canceled','no_show') then reason is not null and length(btrim(reason)) between 1 and 1000 else reason is null end)
);
alter table public.appointment_status_events enable row level security;
drop policy if exists appointment_status_event_read on public.appointment_status_events;
create policy appointment_status_event_read on public.appointment_status_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.appointment_status_events from public,anon,authenticated;
grant select on public.appointment_status_events to authenticated;
create or replace function public.transition_appointment(
 p_organization_id uuid,p_appointment_id uuid,p_target_status text,p_reason text,
 p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointments%rowtype; prior public.appointment_operations%rowtype; fp text; old_status text;
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
 -- 034에서 허용하던 사유 없는 노쇼의 기존 성공 응답은 그대로 재전송한다.
 if p_target_status='no_show' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000) then
  raise exception 'No-show reason required' using errcode='22023'; end if;
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
 old_status=r.status;
 update public.appointments set status=p_target_status,
  cancellation_reason=case when p_target_status='canceled' then btrim(p_reason) else null end,
  no_show_reason=case when p_target_status='no_show' then btrim(p_reason) else null end,
  version=version+1,updated_by=auth.uid(),updated_at=now()
 where id=r.id returning * into r;
 insert into public.appointment_status_events(organization_id,appointment_id,appointment_version,previous_status,next_status,reason,actor_id,operation_id)
 values(p_organization_id,r.id,r.version,old_status,r.status,case when r.status in ('canceled','no_show') then btrim(p_reason) else null end,auth.uid(),p_operation_id);
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) from public,anon;
grant execute on function public.transition_appointment(uuid,uuid,text,text,bigint,uuid) to authenticated;


create or replace function public.get_appointment_status_events(p_organization_id uuid,p_appointment_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Appointment access denied' using errcode='42501'; end if;
 if not exists(select 1 from public.appointments a where a.organization_id=p_organization_id and a.id=p_appointment_id) then
  raise exception 'Appointment not found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'organization_id',e.organization_id,'appointment_id',e.appointment_id,
 'appointment_version',e.appointment_version,'previous_status',e.previous_status,'next_status',e.next_status,'reason',e.reason,
 'actor_id',e.actor_id,'occurred_at',e.occurred_at) order by e.appointment_version),'[]'::jsonb) into result
 from public.appointment_status_events e where e.organization_id=p_organization_id and e.appointment_id=p_appointment_id;
 return result;
end $$;
revoke all on function public.get_appointment_status_events(uuid,uuid) from public,anon;
grant execute on function public.get_appointment_status_events(uuid,uuid) to authenticated;
commit;
