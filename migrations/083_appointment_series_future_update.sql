-- APT-16: apply staff/service template changes to future, unmodified occurrences atomically.
begin;

alter table public.appointment_series_operations drop constraint if exists appointment_series_operations_action_check;
alter table public.appointment_series_operations add constraint appointment_series_operations_action_check
 check(action in ('cancel_future','update_future'));

create or replace function public.update_appointment_series_future(
 p_organization_id uuid,p_series_id uuid,p_staff_id uuid,p_service_id uuid,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appointment_series%rowtype; prior public.appointment_series_operations%rowtype;
 fp text; item record; changed jsonb; updated jsonb:='[]'::jsonb; result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_series_id is null or p_staff_id is null or p_service_id is null or p_operation_id is null then
  raise exception 'Invalid appointment series update' using errcode='22023';
 end if;
 fp=md5(jsonb_build_object('series',p_series_id,'staff',p_staff_id,'service',p_service_id)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-series-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_series_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'update_future' or prior.fingerprint<>fp then
   raise exception 'Appointment series operation conflict' using errcode='P0001';
  end if;
  return prior.result_snapshot||jsonb_build_object('replayed',true);
 end if;
 select * into s from public.appointment_series where organization_id=p_organization_id and id=p_series_id for update;
 if not found then raise exception 'Appointment series not found' using errcode='P0002'; end if;
 if not exists(select 1 from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id and is_active)
  or not exists(select 1 from public.appointment_services where organization_id=p_organization_id and id=p_service_id and is_active) then
  raise exception 'Appointment selection unavailable' using errcode='P0002';
 end if;
 for item in
  select a.* from public.appointment_series_occurrences o
  join public.appointments a on a.organization_id=o.organization_id and a.id=o.appointment_id
  where o.organization_id=p_organization_id and o.series_id=p_series_id and not o.is_exception
   and (a.start_at at time zone 'Asia/Seoul')::date >= (now() at time zone 'Asia/Seoul')::date
   and a.status in ('reserved','confirmed')
  order by o.occurrence_number for update of a
 loop
  changed=public.save_appointment_with_resources(p_organization_id,item.id,item.customer_id,p_staff_id,p_service_id,
   item.start_at,item.source,item.version,gen_random_uuid(),item.resource_ids);
  updated=updated||jsonb_build_array(changed);
 end loop;
 update public.appointment_series_occurrences set is_exception=false
  where organization_id=p_organization_id and series_id=p_series_id
   and appointment_id in (select (value->>'id')::uuid from jsonb_array_elements(updated));
 update public.appointment_series set staff_id=p_staff_id,service_id=p_service_id
  where organization_id=p_organization_id and id=p_series_id;
 result=jsonb_build_object('series_id',p_series_id,'staff_id',p_staff_id,'service_id',p_service_id,'updated',updated,'replayed',false);
 insert into public.appointment_series_operations(organization_id,operation_id,actor_id,action,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'update_future',fp,result);
 return result;
end $$;
revoke all on function public.update_appointment_series_future(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.update_appointment_series_future(uuid,uuid,uuid,uuid,uuid) to authenticated;

commit;
