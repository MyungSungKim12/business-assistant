-- TEAM-11: employee leave requests; only approved requests become booking blocks.
begin;

create table if not exists public.appointment_staff_time_off_requests (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 staff_id uuid not null,
 start_at timestamptz not null,
 end_at timestamptz not null,
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected','withdrawn')),
 version bigint not null default 1 check(version>0),
 requested_by uuid not null references auth.users(id) on delete restrict,
 requested_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id) on delete restrict,
 reviewed_at timestamptz,
 review_note text not null default '' check(length(review_note)<=500),
 withdrawn_by uuid references auth.users(id) on delete restrict,
 withdrawn_at timestamptz,
 time_off_id uuid,
 approval_operation_id uuid not null default gen_random_uuid(),
 foreign key(staff_id,organization_id) references public.appointment_staff(id,organization_id),
 foreign key(time_off_id) references public.appointment_staff_time_off(id) on delete restrict,
 unique(organization_id,id),
 check(end_at>start_at),
 check((status in ('approved','rejected'))=(reviewed_at is not null)),
 check((status='approved')=(time_off_id is not null)),
 check((status='withdrawn')=(withdrawn_at is not null))
);
create index if not exists appointment_staff_leave_request_pending
 on public.appointment_staff_time_off_requests(organization_id,staff_id,start_at)
 where status='pending';
create index if not exists appointment_staff_leave_request_history
 on public.appointment_staff_time_off_requests(organization_id,requested_at desc,id desc);

create table if not exists public.appointment_staff_time_off_request_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 request_id uuid not null,
 event_type text not null check(event_type in ('requested','approved','rejected','withdrawn')),
 actor_id uuid not null references auth.users(id) on delete restrict,
 note text not null default '' check(length(note)<=500),
 created_at timestamptz not null default now(),
 foreign key(organization_id,request_id) references public.appointment_staff_time_off_requests(organization_id,id) on delete cascade
);
create index if not exists appointment_staff_leave_events_history
 on public.appointment_staff_time_off_request_events(organization_id,request_id,created_at,id);

alter table public.appointment_staff_time_off_requests enable row level security;
alter table public.appointment_staff_time_off_request_events enable row level security;
drop policy if exists appointment_staff_leave_request_select on public.appointment_staff_time_off_requests;
create policy appointment_staff_leave_request_select on public.appointment_staff_time_off_requests for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin']::text[])) or exists(
  select 1 from public.appointment_staff s where s.organization_id=appointment_staff_time_off_requests.organization_id
   and s.id=appointment_staff_time_off_requests.staff_id and s.auth_user_id=(select auth.uid())));
drop policy if exists appointment_staff_leave_event_select on public.appointment_staff_time_off_request_events;
create policy appointment_staff_leave_event_select on public.appointment_staff_time_off_request_events for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin']::text[])) or exists(
  select 1 from public.appointment_staff_time_off_requests r join public.appointment_staff s
   on s.organization_id=r.organization_id and s.id=r.staff_id
  where r.organization_id=appointment_staff_time_off_request_events.organization_id
   and r.id=appointment_staff_time_off_request_events.request_id and s.auth_user_id=(select auth.uid())));
revoke all on public.appointment_staff_time_off_requests,public.appointment_staff_time_off_request_events from public,anon,authenticated;
grant select on public.appointment_staff_time_off_requests,public.appointment_staff_time_off_request_events to authenticated;

create or replace function private.prevent_staff_leave_event_change() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Leave request events are immutable' using errcode='42501'; end $$;
revoke all on function private.prevent_staff_leave_event_change() from public,anon,authenticated;
drop trigger if exists immutable on public.appointment_staff_time_off_request_events;
create trigger immutable before update or delete on public.appointment_staff_time_off_request_events
 for each row execute function private.prevent_staff_leave_event_change();

create or replace function public.create_appointment_staff_time_off_request(
 p_organization_id uuid,p_staff_id uuid,p_start_at timestamptz,p_end_at timestamptz,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.appointment_staff_time_off_requests%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_staff_id is null or p_start_at is null or p_end_at is null or p_end_at<=p_start_at
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_operation_id is null then
  raise exception 'Invalid leave request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('action','staff_leave_request','staff',p_staff_id,'start',p_start_at,'end',p_end_at,'reason',btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||p_staff_id::text,0));
 if not exists(select 1 from public.appointment_staff s where s.organization_id=p_organization_id and s.id=p_staff_id and s.is_active and s.auth_user_id=auth.uid()) then
  raise exception 'Linked active staff account required' using errcode='42501'; end if;
 if exists(select 1 from public.appointment_staff_time_off_requests r where r.organization_id=p_organization_id and r.staff_id=p_staff_id
  and r.status='pending' and r.start_at<p_end_at and p_start_at<r.end_at) then
  raise exception 'Overlapping leave request exists' using errcode='P0001'; end if;
 if exists(select 1 from public.appointment_staff_time_off o where o.organization_id=p_organization_id and o.staff_id=p_staff_id
  and o.status='active' and o.start_at<p_end_at and p_start_at<o.end_at) then
  raise exception 'Leave overlaps approved time off' using errcode='P0001'; end if;
 insert into public.appointment_staff_time_off_requests(organization_id,staff_id,start_at,end_at,reason,requested_by)
  values(p_organization_id,p_staff_id,p_start_at,p_end_at,btrim(p_reason),auth.uid()) returning * into request_row;
 insert into public.appointment_staff_time_off_request_events(organization_id,request_id,event_type,actor_id)
  values(p_organization_id,request_row.id,'requested',auth.uid());
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(request_row));
 return to_jsonb(request_row);
end $$;
revoke all on function public.create_appointment_staff_time_off_request(uuid,uuid,timestamptz,timestamptz,text,uuid) from public,anon;
grant execute on function public.create_appointment_staff_time_off_request(uuid,uuid,timestamptz,timestamptz,text,uuid) to authenticated;

create or replace function public.list_appointment_staff_time_off_requests(p_organization_id uuid,p_staff_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; manager boolean; self_staff uuid;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 manager=private.has_organization_role(p_organization_id,array['owner','admin']::text[]);
 select s.id into self_staff from public.appointment_staff s where s.organization_id=p_organization_id and s.auth_user_id=auth.uid() and s.is_active;
 if not manager and (p_staff_id is not null or self_staff is null) then
  raise exception 'Linked staff account required' using errcode='42501'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.requested_at desc,r.id desc),'[]'::jsonb) into result
 from (select * from public.appointment_staff_time_off_requests r where r.organization_id=p_organization_id
  and (manager and (p_staff_id is null or r.staff_id=p_staff_id) or not manager and r.staff_id=self_staff)
  order by r.requested_at desc,r.id desc limit 200) r;
 return jsonb_build_object('current_staff_id',self_staff,'requests',result);
end $$;
revoke all on function public.list_appointment_staff_time_off_requests(uuid,uuid) from public,anon;
grant execute on function public.list_appointment_staff_time_off_requests(uuid,uuid) to authenticated;

create or replace function public.review_appointment_staff_time_off_request(
 p_organization_id uuid,p_request_id uuid,p_action text,p_expected_version bigint,p_operation_id uuid,p_review_note text default ''
) returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.appointment_staff_time_off_requests%rowtype; prior public.appointment_operations%rowtype; fp text; block jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_request_id is null or p_action not in ('approve','reject') or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_review_note is null or length(p_review_note)>500 then raise exception 'Invalid leave review' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('action','staff_leave_review','request',p_request_id,'decision',p_action,'version',p_expected_version,'note',btrim(p_review_note))::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into request_row from public.appointment_staff_time_off_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found then raise exception 'Leave request not found' using errcode='P0002'; end if;
 if request_row.status<>'pending' or request_row.version<>p_expected_version then raise exception 'Leave request changed' using errcode='P0001'; end if;
 if p_action='approve' then
  block=public.create_appointment_staff_time_off(p_organization_id,request_row.staff_id,request_row.start_at,request_row.end_at,request_row.reason,request_row.approval_operation_id);
  update public.appointment_staff_time_off_requests set status='approved',version=version+1,reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_review_note),time_off_id=(block->>'id')::uuid
   where organization_id=p_organization_id and id=p_request_id returning * into request_row;
 else
  update public.appointment_staff_time_off_requests set status='rejected',version=version+1,reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_review_note)
   where organization_id=p_organization_id and id=p_request_id returning * into request_row;
 end if;
 insert into public.appointment_staff_time_off_request_events(organization_id,request_id,event_type,actor_id,note)
  values(p_organization_id,p_request_id,case when p_action='approve' then 'approved' else 'rejected' end,auth.uid(),btrim(p_review_note));
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(request_row));
 return to_jsonb(request_row);
end $$;
revoke all on function public.review_appointment_staff_time_off_request(uuid,uuid,text,bigint,uuid,text) from public,anon;
grant execute on function public.review_appointment_staff_time_off_request(uuid,uuid,text,bigint,uuid,text) to authenticated;

create or replace function public.withdraw_appointment_staff_time_off_request(
 p_organization_id uuid,p_request_id uuid,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.appointment_staff_time_off_requests%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_request_id is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null then raise exception 'Invalid leave withdrawal' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('action','staff_leave_withdraw','request',p_request_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select r.* into request_row from public.appointment_staff_time_off_requests r join public.appointment_staff s
  on s.organization_id=r.organization_id and s.id=r.staff_id
  where r.organization_id=p_organization_id and r.id=p_request_id and s.auth_user_id=auth.uid() for update of r;
 if not found then raise exception 'Leave request not found' using errcode='P0002'; end if;
 if request_row.status<>'pending' or request_row.version<>p_expected_version then raise exception 'Leave request changed' using errcode='P0001'; end if;
 update public.appointment_staff_time_off_requests set status='withdrawn',version=version+1,withdrawn_by=auth.uid(),withdrawn_at=now()
  where organization_id=p_organization_id and id=p_request_id returning * into request_row;
 insert into public.appointment_staff_time_off_request_events(organization_id,request_id,event_type,actor_id)
  values(p_organization_id,p_request_id,'withdrawn',auth.uid());
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(request_row));
 return to_jsonb(request_row);
end $$;
revoke all on function public.withdraw_appointment_staff_time_off_request(uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.withdraw_appointment_staff_time_off_request(uuid,uuid,bigint,uuid) to authenticated;

commit;
