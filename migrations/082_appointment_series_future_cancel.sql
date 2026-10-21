-- APT-16: atomically cancel only still-booked occurrences on/after a KST date.
begin;

create table if not exists public.appointment_series_operations (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 operation_id uuid not null,
 actor_id uuid not null references auth.users(id),
 action text not null check(action='cancel_future'),
 fingerprint text not null,
 result_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,operation_id)
);
alter table public.appointment_series_operations enable row level security;
revoke all on public.appointment_series_operations from public,anon,authenticated;

create or replace function public.cancel_future_appointment_series(
 p_organization_id uuid,p_series_id uuid,p_from_date date,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appointment_series%rowtype; prior public.appointment_series_operations%rowtype;
 fp text; item record; changed jsonb; canceled jsonb:='[]'::jsonb; result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_series_id is null or p_from_date is null or p_operation_id is null or p_reason is null
  or length(btrim(p_reason)) not between 1 and 1000 then
  raise exception 'Invalid appointment series cancellation' using errcode='22023';
 end if;
 fp=md5(jsonb_build_object('series',p_series_id,'from_date',p_from_date,'reason',btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-series-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_series_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'cancel_future' or prior.fingerprint<>fp then
   raise exception 'Appointment series operation conflict' using errcode='P0001';
  end if;
  return prior.result_snapshot||jsonb_build_object('replayed',true);
 end if;
 select * into s from public.appointment_series where organization_id=p_organization_id and id=p_series_id for update;
 if not found then raise exception 'Appointment series not found' using errcode='P0002'; end if;
 for item in
  select a.id,a.version from public.appointment_series_occurrences o
  join public.appointments a on a.organization_id=o.organization_id and a.id=o.appointment_id
  where o.organization_id=p_organization_id and o.series_id=p_series_id
   and (a.start_at at time zone 'Asia/Seoul')::date>=p_from_date
   and a.status in ('reserved','confirmed')
  order by o.occurrence_number for update of a
 loop
  changed=public.transition_appointment(p_organization_id,item.id,'canceled',btrim(p_reason),item.version,gen_random_uuid());
  canceled=canceled||jsonb_build_array(changed);
 end loop;
 result=jsonb_build_object('series_id',p_series_id,'from_date',p_from_date,'reason',btrim(p_reason),'canceled',canceled,'replayed',false);
 insert into public.appointment_series_operations(organization_id,operation_id,actor_id,action,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'cancel_future',fp,result);
 return result;
end $$;
revoke all on function public.cancel_future_appointment_series(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.cancel_future_appointment_series(uuid,uuid,date,text,uuid) to authenticated;

commit;
