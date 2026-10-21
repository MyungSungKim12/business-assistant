-- APT-16: weekly/monthly appointment series with conflict reporting and per-visit exceptions.
begin;

create table if not exists public.appointment_series (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 customer_id uuid not null,
 staff_id uuid not null,
 service_id uuid not null,
 frequency text not null check (frequency in ('weekly','monthly')),
 interval_count integer not null default 1 check (interval_count between 1 and 12),
 occurrence_count integer not null check (occurrence_count between 2 and 52),
 resource_ids uuid[] not null default '{}',
 source text not null default 'manual' check (source in ('manual','phone','walk_in','online')),
 operation_id uuid not null,
 actor_id uuid not null references auth.users(id),
 fingerprint text not null,
 result_snapshot jsonb,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique (organization_id,id),
 foreign key (customer_id,organization_id) references public.customers(id,organization_id),
 foreign key (staff_id,organization_id) references public.appointment_staff(id,organization_id),
 foreign key (service_id,organization_id) references public.appointment_services(id,organization_id)
);
alter table public.appointment_series add column if not exists operation_id uuid;
alter table public.appointment_series add column if not exists actor_id uuid references auth.users(id);
alter table public.appointment_series add column if not exists fingerprint text;
alter table public.appointment_series add column if not exists result_snapshot jsonb;
create unique index if not exists appointment_series_operation_once on public.appointment_series(organization_id,operation_id) where operation_id is not null;
create table if not exists public.appointment_series_occurrences (
 organization_id uuid not null,
 series_id uuid not null,
 appointment_id uuid not null,
 occurrence_number integer not null check (occurrence_number between 1 and 52),
 scheduled_start_at timestamptz not null,
 is_exception boolean not null default false,
 primary key (organization_id,series_id,occurrence_number),
 unique (organization_id,appointment_id),
 foreign key (organization_id,series_id) references public.appointment_series(organization_id,id) on delete cascade,
 foreign key (organization_id,appointment_id) references public.appointments(organization_id,id) on delete cascade
);
create table if not exists public.appointment_series_exceptions (
 organization_id uuid not null,
 series_id uuid not null,
 exception_date date not null,
 reason text not null default '' check (length(reason)<=500),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 primary key (organization_id,series_id,exception_date),
 foreign key (organization_id,series_id) references public.appointment_series(organization_id,id) on delete cascade
);
create index if not exists appointment_series_customer on public.appointment_series(organization_id,customer_id,created_at desc);
alter table public.appointment_series enable row level security;
alter table public.appointment_series_occurrences enable row level security;
alter table public.appointment_series_exceptions enable row level security;
drop policy if exists appointment_series_member_select on public.appointment_series;
create policy appointment_series_member_select on public.appointment_series for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_series_occurrence_member_select on public.appointment_series_occurrences;
create policy appointment_series_occurrence_member_select on public.appointment_series_occurrences for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_series_exception_member_select on public.appointment_series_exceptions;
create policy appointment_series_exception_member_select on public.appointment_series_exceptions for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.appointment_series,public.appointment_series_occurrences,public.appointment_series_exceptions from public,anon,authenticated;
grant select on public.appointment_series,public.appointment_series_occurrences,public.appointment_series_exceptions to authenticated;

create or replace function private.mark_appointment_series_exception() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.customer_id is distinct from old.customer_id or new.staff_id is distinct from old.staff_id
  or new.service_id is distinct from old.service_id or new.start_at is distinct from old.start_at
  or new.end_at is distinct from old.end_at or new.resource_ids is distinct from old.resource_ids then
  update public.appointment_series_occurrences set is_exception=true
   where organization_id=old.organization_id and appointment_id=old.id;
 end if;
 return new;
end $$;
revoke all on function private.mark_appointment_series_exception() from public,anon,authenticated;
drop trigger if exists appointment_series_mark_exception on public.appointments;
create trigger appointment_series_mark_exception after update on public.appointments
 for each row execute function private.mark_appointment_series_exception();

create or replace function public.create_appointment_series(
 p_organization_id uuid,p_customer_id uuid,p_staff_id uuid,p_service_id uuid,
 p_start_at timestamptz,p_frequency text,p_interval_count integer,p_occurrence_count integer,
 p_resource_ids uuid[],p_source text,p_exception_dates date[],p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; i integer; start_value timestamptz; local_start timestamp; saved jsonb; created jsonb:='[]'::jsonb; skipped jsonb:='[]'::jsonb;
        candidate date; op uuid; service_row public.appointment_services%rowtype; fp text; prior public.appointment_series%rowtype; response jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_customer_id is null or p_staff_id is null or p_service_id is null or p_start_at is null
  or p_operation_id is null or p_frequency is null or p_frequency not in ('weekly','monthly') or p_interval_count not between 1 and 12
  or p_occurrence_count not between 2 and 52 or p_resource_ids is null or cardinality(p_resource_ids)>20
  or cardinality(coalesce(p_exception_dates,'{}'::date[]))>52 or p_source is null or p_source not in ('manual','phone','walk_in','online') then
  raise exception 'Invalid appointment series' using errcode='22023'; end if;
 if cardinality(p_resource_ids)<>(select count(distinct x) from unnest(p_resource_ids) x) then
  raise exception 'Duplicate appointment resource' using errcode='22023'; end if;
 if cardinality(coalesce(p_exception_dates,'{}'::date[]))<>(select count(distinct x) from unnest(coalesce(p_exception_dates,'{}'::date[])) x) then
  raise exception 'Duplicate exception date' using errcode='22023'; end if;
 select * into service_row from public.appointment_services where organization_id=p_organization_id and id=p_service_id and is_active;
 if not found or not exists(select 1 from public.customers where organization_id=p_organization_id and id=p_customer_id and status not in ('blocked','inactive'))
  or not exists(select 1 from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id and is_active) then
  raise exception 'Appointment selection unavailable' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended('appointment-series:'||p_organization_id::text||p_operation_id::text,0));
 fp=md5(jsonb_build_object('customer',p_customer_id,'staff',p_staff_id,'service',p_service_id,'start',p_start_at,
  'frequency',p_frequency,'interval',p_interval_count,'count',p_occurrence_count,'resources',p_resource_ids,
  'source',p_source,'exceptions',coalesce(p_exception_dates,'{}'::date[]))::text);
 select * into prior from public.appointment_series where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Appointment series operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 insert into public.appointment_series(organization_id,customer_id,staff_id,service_id,frequency,interval_count,occurrence_count,resource_ids,source,operation_id,actor_id,fingerprint,created_by)
 values(p_organization_id,p_customer_id,p_staff_id,p_service_id,p_frequency,p_interval_count,p_occurrence_count,p_resource_ids,p_source,p_operation_id,auth.uid(),fp,auth.uid()) returning id into sid;
 local_start=p_start_at at time zone 'Asia/Seoul';
 foreach candidate in array coalesce(p_exception_dates,'{}'::date[]) loop
  if candidate < local_start::date or candidate > (local_start::date + interval '612 months')::date then raise exception 'Invalid exception date' using errcode='22023'; end if;
  insert into public.appointment_series_exceptions(organization_id,series_id,exception_date,created_by)
   values(p_organization_id,sid,candidate,auth.uid());
 end loop;
 for i in 0..p_occurrence_count-1 loop
  if p_frequency='weekly' then candidate=(local_start::date + (i*p_interval_count*7));
  else candidate=(local_start::date + make_interval(months=>i*p_interval_count))::date; end if;
  if candidate=any(coalesce(p_exception_dates,'{}'::date[])) then
   skipped=skipped||jsonb_build_object('number',i+1,'date',candidate,'reason','exception_date'); continue;
  end if;
  start_value=(candidate::timestamp + local_start::time) at time zone 'Asia/Seoul';
  op=(substr(md5(sid::text||':'||i::text),1,8)||'-'||substr(md5(sid::text||':'||i::text),9,4)||'-4'||substr(md5(sid::text||':'||i::text),14,3)||'-a'||substr(md5(sid::text||':'||i::text),18,3)||'-'||substr(md5(sid::text||':'||i::text),21,12))::uuid;
  begin
   saved=public.save_appointment_with_resources(p_organization_id,null,p_customer_id,p_staff_id,p_service_id,start_value,p_source,null,op,p_resource_ids);
   insert into public.appointment_series_occurrences(organization_id,series_id,appointment_id,occurrence_number,scheduled_start_at)
    values(p_organization_id,sid,(saved->>'id')::uuid,i+1,start_value);
   created=created||jsonb_build_object('number',i+1,'appointment',saved);
  exception when sqlstate 'P0001' then
   skipped=skipped||jsonb_build_object('number',i+1,'date',candidate,'reason','conflict');
  end;
 end loop;
 if jsonb_array_length(created)=0 then raise exception 'No appointment occurrence could be booked' using errcode='P0001'; end if;
 response=jsonb_build_object('series_id',sid,'created',created,'skipped',skipped);
 update public.appointment_series set result_snapshot=response where organization_id=p_organization_id and id=sid;
 return response;
end $$;
revoke all on function public.create_appointment_series(uuid,uuid,uuid,uuid,timestamptz,text,integer,integer,uuid[],text,date[],uuid) from public,anon;
grant execute on function public.create_appointment_series(uuid,uuid,uuid,uuid,timestamptz,text,integer,integer,uuid[],text,date[],uuid) to authenticated;

create or replace function public.list_appointment_series(p_organization_id uuid,p_series_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 select jsonb_build_object('series',to_jsonb(s),'occurrences',coalesce((select jsonb_agg(jsonb_build_object('occurrence_number',o.occurrence_number,'scheduled_start_at',o.scheduled_start_at,'is_exception',o.is_exception,'appointment',to_jsonb(a)) order by o.occurrence_number)
  from public.appointment_series_occurrences o join public.appointments a on a.organization_id=o.organization_id and a.id=o.appointment_id
  where o.organization_id=s.organization_id and o.series_id=s.id),'[]'::jsonb),'exceptions',coalesce((select jsonb_agg(to_jsonb(e) order by e.exception_date) from public.appointment_series_exceptions e where e.organization_id=s.organization_id and e.series_id=s.id),'[]'::jsonb))
 into result from public.appointment_series s where s.organization_id=p_organization_id and s.id=p_series_id;
 if result is null then raise exception 'Appointment series not found' using errcode='P0002'; end if;
 return result;
end $$;
revoke all on function public.list_appointment_series(uuid,uuid) from public,anon;
grant execute on function public.list_appointment_series(uuid,uuid) to authenticated;
commit;
