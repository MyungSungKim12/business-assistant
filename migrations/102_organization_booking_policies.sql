-- N1030-02 / SET-001. Organization-wide policy; disabled defaults preserve legacy behavior.
begin;
create table if not exists public.organization_booking_policies(
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 version bigint not null check(version>0),
 policy jsonb not null check(jsonb_typeof(policy)='object' and octet_length(policy::text)<=100000),
 updated_by uuid not null,updated_at timestamptz not null default now()
);
create table if not exists public.organization_booking_policy_operations(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 operation_id uuid not null,actor_id uuid not null,fingerprint text not null,
 result_snapshot jsonb not null,created_at timestamptz not null default now(),
 primary key(organization_id,operation_id)
);
alter table public.organization_booking_policies enable row level security;
alter table public.organization_booking_policy_operations enable row level security;
revoke all on public.organization_booking_policies,public.organization_booking_policy_operations from public,anon,authenticated;

create or replace function private.default_booking_policy() returns jsonb
language sql immutable set search_path='' as $$
 select '{"enabled":false,"timezone_name":"Asia/Seoul","minimum_notice_minutes":0,"same_day_cutoff_time":null,"hours":[],"blocks":[]}'::jsonb
$$;

create or replace function private.validate_booking_policy(p jsonb) returns void
language plpgsql stable set search_path='' as $$
declare h jsonb;b jsonb;s timestamptz;e timestamptz;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>100000
  or not(p ?& array['enabled','timezone_name','minimum_notice_minutes','same_day_cutoff_time','hours','blocks'])
  or p-array['enabled','timezone_name','minimum_notice_minutes','same_day_cutoff_time','hours','blocks']<>'{}'::jsonb
  or jsonb_typeof(p->'enabled')<>'boolean' or jsonb_typeof(p->'timezone_name')<>'string'
  or not exists(select 1 from pg_catalog.pg_timezone_names where name=p->>'timezone_name')
  or jsonb_typeof(p->'minimum_notice_minutes')<>'number' or (p->>'minimum_notice_minutes')!~'^[0-9]+$'
  or (p->>'minimum_notice_minutes')::numeric not between 0 and 525600
  or not(p->'same_day_cutoff_time'='null'::jsonb or (jsonb_typeof(p->'same_day_cutoff_time')='string' and (p->>'same_day_cutoff_time')~'^([01][0-9]|2[0-3]):[0-5][0-9]$'))
  or jsonb_typeof(p->'hours')<>'array' or jsonb_typeof(p->'blocks')<>'array' then
  raise exception 'Invalid booking policy' using errcode='22023';
 end if;
 if jsonb_array_length(p->'hours')>70 or jsonb_array_length(p->'blocks')>200 then raise exception 'Booking policy list limit exceeded' using errcode='22023';end if;
 for h in select value from jsonb_array_elements(p->'hours') loop
  if jsonb_typeof(h)<>'object' or not(h ?& array['weekday','start_time','end_time']) or h-array['weekday','start_time','end_time']<>'{}'::jsonb
   or jsonb_typeof(h->'weekday')<>'number' or (h->>'weekday')!~'^[1-7]$'
   or jsonb_typeof(h->'start_time')<>'string' or (h->>'start_time')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
   or jsonb_typeof(h->'end_time')<>'string' or (h->>'end_time')!~'^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
   or (h->>'start_time')>=(h->>'end_time') then raise exception 'Invalid booking hours' using errcode='22023';end if;
 end loop;
 -- Overlapping hours and blocks are intentionally allowed; every occupied interval must fit ONE hours row.
 for b in select value from jsonb_array_elements(p->'blocks') loop
  if jsonb_typeof(b)<>'object' or not(b ?& array['start_at','end_at','reason']) or b-array['start_at','end_at','reason']<>'{}'::jsonb
   or jsonb_typeof(b->'start_at')<>'string' or jsonb_typeof(b->'end_at')<>'string'
   or (b->>'start_at')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
   or (b->>'end_at')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
   or jsonb_typeof(b->'reason')<>'string' or length(b->>'reason')>500 then raise exception 'Invalid booking block' using errcode='22023';end if;
  begin s=(b->>'start_at')::timestamptz;e=(b->>'end_at')::timestamptz;
   exception when others then raise exception 'Invalid booking block timestamp' using errcode='22023';end;
  if not isfinite(s) or not isfinite(e) or e<=s or e-s>interval '366 days' then raise exception 'Invalid booking block range' using errcode='22023';end if;
 end loop;
end $$;

create or replace function public.get_organization_booking_policy(p_organization_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 select policy||jsonb_build_object('organization_id',organization_id,'version',version) into result from public.organization_booking_policies where organization_id=p_organization_id;
 return coalesce(result,private.default_booking_policy()||jsonb_build_object('organization_id',p_organization_id,'version',0));
end $$;

create or replace function public.save_organization_booking_policy(p_organization_id uuid,p_expected_version bigint,p_operation_id uuid,p_policy jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare prior public.organization_booking_policy_operations%rowtype;fp text;v bigint;result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_expected_version is null or p_expected_version<0 or p_operation_id is null then raise exception 'Invalid booking policy version/operation' using errcode='22023';end if;
 perform private.validate_booking_policy(p_policy);
 fp=md5(jsonb_build_object('version',p_expected_version,'policy',p_policy)::text);
 -- One lock domain for policy changes and guarded booking writes, including absent policy rows.
 -- Policy saves never lock appointment/staff/resource rows, so no reverse lock edge is introduced.
 perform pg_advisory_xact_lock(hashtextextended('organization-booking-policy:'||p_organization_id::text,0));
 select * into prior from public.organization_booking_policy_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Booking policy operation conflict' using errcode='P0001';end if;
  return prior.result_snapshot;
 end if;
 select version into v from public.organization_booking_policies where organization_id=p_organization_id;
 if coalesce(v,0)<>p_expected_version then raise exception 'Booking policy changed' using errcode='P0001';end if;
 v=coalesce(v,0)+1;
 insert into public.organization_booking_policies(organization_id,version,policy,updated_by) values(p_organization_id,v,p_policy,auth.uid())
 on conflict(organization_id) do update set version=excluded.version,policy=excluded.policy,updated_by=excluded.updated_by,updated_at=now();
 result=p_policy||jsonb_build_object('organization_id',p_organization_id,'version',v);
 insert into public.organization_booking_policy_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot) values(p_organization_id,p_operation_id,auth.uid(),fp,result);
 insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata)
 values(p_organization_id,auth.uid(),'booking_policy.saved','booking_policy',p_organization_id::text,jsonb_build_object('version',v,'previous_version',p_expected_version,'operation_id',p_operation_id,'enabled',p_policy->'enabled'));
 return result;
end $$;

create or replace function private.booking_policy_reason(p jsonb,s timestamptz,e timestamptz,n timestamptz) returns text
language plpgsql stable set search_path='' as $$
declare ls timestamp;ll timestamp;ln timestamp;last_at timestamptz;
begin
 if not(p->>'enabled')::boolean then return null;end if;
 if s<n+make_interval(mins=>(p->>'minimum_notice_minutes')::integer) then return 'booking_policy_notice';end if;
 last_at=e-interval '1 microsecond';ls=s at time zone (p->>'timezone_name');ll=last_at at time zone (p->>'timezone_name');ln=n at time zone (p->>'timezone_name');
 if p->>'same_day_cutoff_time' is not null and ls::date=ln::date and ln::time>=(p->>'same_day_cutoff_time')::time then return 'booking_policy_cutoff';end if;
 -- Fail closed across an offset transition. End is exclusive: ending exactly at a transition is valid.
 if ls-(s at time zone 'UTC')<>ll-(last_at at time zone 'UTC') then return 'booking_policy_timezone_transition';end if;
 if not exists(select 1 from jsonb_array_elements(p->'hours')h where (h->>'weekday')::integer=extract(isodow from ls)
  and ls>=ls::date+(h->>'start_time')::time and ll<ls::date+(h->>'end_time')::time) then return 'booking_policy_hours';end if;
 if exists(select 1 from jsonb_array_elements(p->'blocks')b where s<(b->>'end_at')::timestamptz and (b->>'start_at')::timestamptz<e) then return 'booking_policy_block';end if;
 return null;
end $$;

create or replace function private.enforce_organization_booking_policy() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare p jsonb;reason text;
begin
 if new.status not in ('reserved','confirmed','checked_in') then return null;end if;
 if tg_op='UPDATE' then
  if old.status in ('reserved','confirmed','checked_in') and
   row(new.organization_id,new.staff_id,new.service_id,new.start_at,new.end_at,new.duration_minutes,new.buffer_minutes)
   is not distinct from row(old.organization_id,old.staff_id,old.service_id,old.start_at,old.end_at,old.duration_minutes,old.buffer_minutes) then return null;end if;
 end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('organization-booking-policy:'||new.organization_id::text,0));
 select policy into p from public.organization_booking_policies where organization_id=new.organization_id;
 if not found then return null;end if;
 reason=private.booking_policy_reason(p,new.start_at,new.end_at+make_interval(mins=>new.buffer_minutes),statement_timestamp());
 if reason is not null then raise exception 'Appointment violates organization booking policy: %',reason using errcode='23514';end if;
 return null;
end $$;
-- AFTER observes final occupancy calculated by existing BEFORE guards and covers direct and series writes.
drop trigger if exists appointments_organization_booking_policy on public.appointments;
create trigger appointments_organization_booking_policy after insert or update on public.appointments for each row execute function private.enforce_organization_booking_policy();
revoke all on function private.default_booking_policy(),private.validate_booking_policy(jsonb),private.booking_policy_reason(jsonb,timestamptz,timestamptz,timestamptz),private.enforce_organization_booking_policy() from public,anon,authenticated;
revoke all on function public.get_organization_booking_policy(uuid),public.save_organization_booking_policy(uuid,bigint,uuid,jsonb) from public,anon;
grant execute on function public.get_organization_booking_policy(uuid),public.save_organization_booking_policy(uuid,bigint,uuid,jsonb) to authenticated;
commit;
