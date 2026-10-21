-- APT-16: atomically change the schedule cadence and resources for future base occurrences.
begin;

alter table public.appointment_series_operations drop constraint if exists appointment_series_operations_action_check;
alter table public.appointment_series_operations add constraint appointment_series_operations_action_check
 check(action in ('cancel_future','update_future','reschedule_future'));

create or replace function public.reschedule_appointment_series_future(
 p_organization_id uuid,p_series_id uuid,p_from_occurrence_number integer,p_start_at timestamptz,
 p_frequency text,p_interval_count integer,p_resource_ids uuid[],p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appointment_series%rowtype; prior public.appointment_series_operations%rowtype;
 fp text; item record; changed jsonb; updated jsonb:='[]'::jsonb; result jsonb;
 anchor_local timestamp; candidate date; start_value timestamptz; offset_count integer;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_series_id is null or p_from_occurrence_number not between 1 and 52 or p_start_at is null
  or (p_start_at at time zone 'Asia/Seoul')::date<(now() at time zone 'Asia/Seoul')::date
  or p_frequency not in ('weekly','monthly') or p_interval_count not between 1 and 12
  or p_resource_ids is null or cardinality(p_resource_ids)>20 or p_operation_id is null
  or cardinality(p_resource_ids)<>(select count(distinct x) from unnest(p_resource_ids) x) then
  raise exception 'Invalid appointment series schedule' using errcode='22023';
 end if;
 fp=md5(jsonb_build_object('series',p_series_id,'from_occurrence',p_from_occurrence_number,'start',p_start_at,
  'frequency',p_frequency,'interval',p_interval_count,'resources',p_resource_ids)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-series-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_series_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'reschedule_future' or prior.fingerprint<>fp then
   raise exception 'Appointment series operation conflict' using errcode='P0001';
  end if;
  return prior.result_snapshot||jsonb_build_object('replayed',true);
 end if;
 select * into s from public.appointment_series where organization_id=p_organization_id and id=p_series_id for update;
 if not found then raise exception 'Appointment series not found' using errcode='P0002'; end if;
 if exists(select 1 from unnest(p_resource_ids) rid left join public.appointment_resources r
   on r.organization_id=p_organization_id and r.id=rid and r.is_active where r.id is null) then
  raise exception 'Appointment resource unavailable' using errcode='P0002';
 end if;
 anchor_local=p_start_at at time zone 'Asia/Seoul';
 for item in
  select a.*,o.occurrence_number from public.appointment_series_occurrences o
  join public.appointments a on a.organization_id=o.organization_id and a.id=o.appointment_id
  where o.organization_id=p_organization_id and o.series_id=p_series_id and o.occurrence_number>=p_from_occurrence_number
   and not o.is_exception and (a.start_at at time zone 'Asia/Seoul')::date >= (now() at time zone 'Asia/Seoul')::date
   and a.status in ('reserved','confirmed')
  order by o.occurrence_number for update of a
 loop
  offset_count=item.occurrence_number-p_from_occurrence_number;
  if p_frequency='weekly' then candidate=(anchor_local::date+(offset_count*p_interval_count*7));
  else candidate=(anchor_local::date+make_interval(months=>offset_count*p_interval_count))::date; end if;
  start_value=(candidate::timestamp+anchor_local::time) at time zone 'Asia/Seoul';
  changed=public.save_appointment_with_resources(p_organization_id,item.id,item.customer_id,s.staff_id,s.service_id,
   start_value,item.source,item.version,gen_random_uuid(),p_resource_ids);
  updated=updated||jsonb_build_array(changed);
 end loop;
 if jsonb_array_length(updated)=0 then raise exception 'No eligible future appointment occurrences' using errcode='P0001'; end if;
 update public.appointment_series_occurrences o set scheduled_start_at=(u.value->>'start_at')::timestamptz,is_exception=false
  from jsonb_array_elements(updated) u(value)
  where o.organization_id=p_organization_id and o.series_id=p_series_id and o.appointment_id=(u.value->>'id')::uuid;
 update public.appointment_series set frequency=p_frequency,interval_count=p_interval_count,resource_ids=p_resource_ids
  where organization_id=p_organization_id and id=p_series_id;
 result=jsonb_build_object('series_id',p_series_id,'from_occurrence_number',p_from_occurrence_number,'start_at',p_start_at,
  'frequency',p_frequency,'interval_count',p_interval_count,'resource_ids',p_resource_ids,'updated',updated,'replayed',false);
 insert into public.appointment_series_operations(organization_id,operation_id,actor_id,action,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'reschedule_future',fp,result);
 return result;
end $$;
revoke all on function public.reschedule_appointment_series_future(uuid,uuid,integer,timestamptz,text,integer,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.reschedule_appointment_series_future(uuid,uuid,integer,timestamptz,text,integer,uuid[],uuid) to authenticated;

commit;
