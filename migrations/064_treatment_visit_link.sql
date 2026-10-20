-- APT-004 / TRT-001,003: explicit links only; no visit/treatment/payment creation or historical backfill.
-- Apply after 063. Existing links remain NULL. Re-applicable without dropping historical events.
begin;
alter table public.treatment_records add column if not exists appointment_id uuid;
alter table public.treatment_records add column if not exists visit_id uuid;
create unique index if not exists appointments_org_id_customer on public.appointments(organization_id,id,customer_id);
alter table public.treatment_records drop constraint if exists treatment_records_appointment_context;
alter table public.treatment_records add constraint treatment_records_appointment_context
 foreign key(organization_id,appointment_id,customer_id) references public.appointments(organization_id,id,customer_id)
 deferrable initially deferred;
alter table public.treatment_records drop constraint if exists treatment_records_visit_context;
alter table public.treatment_records add constraint treatment_records_visit_context
 foreign key(organization_id,visit_id,customer_id) references public.customer_visits(organization_id,id,customer_id)
 deferrable initially deferred;
create index if not exists treatment_records_appointment_context on public.treatment_records(organization_id,appointment_id,customer_id) where appointment_id is not null;
create index if not exists treatment_records_visit_context on public.treatment_records(organization_id,visit_id,customer_id) where visit_id is not null;
alter table public.treatment_record_events drop constraint if exists treatment_record_events_action_check;
alter table public.treatment_record_events add constraint treatment_record_events_action_check
 check(action in ('edit','correct','start','complete','cancel','consult','service_link','visit_link'));

-- Deferred checks allow the existing customer-merge transaction to move all parents and children.
create or replace function private.check_treatment_visit_context() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.treatment_records t join public.customer_visits v
   on v.organization_id=t.organization_id and v.id=t.visit_id
   where ((tg_table_name='treatment_records' and t.id=new.id)
      or (tg_table_name='customer_visits' and v.id=new.id))
   and t.appointment_id is distinct from v.appointment_id) then
  raise exception 'Treatment visit appointment mismatch' using errcode='23514';
 end if;
 return null;
end $$;
revoke all on function private.check_treatment_visit_context() from public,anon,authenticated;
drop trigger if exists treatment_visit_context_check on public.treatment_records;
create constraint trigger treatment_visit_context_check after insert or update on public.treatment_records
 deferrable initially deferred for each row execute function private.check_treatment_visit_context();
drop trigger if exists visit_treatment_context_check on public.customer_visits;
create constraint trigger visit_treatment_context_check after update on public.customer_visits
 deferrable initially deferred for each row execute function private.check_treatment_visit_context();

create or replace function public.set_treatment_visit_link(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_appointment_id uuid,p_visit_id uuid,
 p_expected_version integer,p_operation_id uuid,p_reason text
) returns setof public.treatment_records language plpgsql security definer set search_path='' as $$
declare t public.treatment_records%rowtype; before_row public.treatment_records%rowtype;
 a public.appointments%rowtype; v public.customer_visits%rowtype;
 prior public.treatment_record_events%rowtype; request jsonb; now_at timestamptz;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_reason is null or p_reason !~ '[^[:space:]]' or char_length(p_reason)>2000 then
  raise exception 'Operation, version and reason required' using errcode='22023'; end if;
 -- Same customer lock order as the merge operation, then treatment and parent rows.
 perform 1 from public.customers where organization_id=p_organization_id and id=p_customer_id for share;
 if not found then raise exception 'Customer not found' using errcode='P0002'; end if;
 select * into t from public.treatment_records where organization_id=p_organization_id and customer_id=p_customer_id and id=p_treatment_id for update;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 request=jsonb_build_object('actor_id',auth.uid(),'action','visit_link','appointment_id',p_appointment_id,
  'visit_id',p_visit_id,'expected_version',p_expected_version,'reason',p_reason);
 select * into prior from public.treatment_record_events where treatment_id=p_treatment_id and operation_id=p_operation_id;
 if found then
  if prior.request_data<>request then raise exception 'Operation ID reused' using errcode='P0001'; end if;
  return next t; return;
 end if;
 if t.version<>p_expected_version or t.status not in ('draft','in_progress') then
  raise exception 'Treatment changed or context locked' using errcode='P0001'; end if;
 if p_appointment_id is not null then
  select * into a from public.appointments where organization_id=p_organization_id and id=p_appointment_id and customer_id=p_customer_id for share;
  if not found or a.status in ('canceled','no_show') then raise exception 'Invalid appointment context' using errcode='22023'; end if;
 end if;
 if p_visit_id is not null then
  select * into v from public.customer_visits where organization_id=p_organization_id and id=p_visit_id and customer_id=p_customer_id for share;
  if not found or v.status='canceled' or v.appointment_id is distinct from p_appointment_id then
   raise exception 'Invalid visit context' using errcode='22023'; end if;
 end if;
 before_row=t;now_at=clock_timestamp();
 update public.treatment_records set appointment_id=p_appointment_id,visit_id=p_visit_id,version=version+1,updated_at=now_at
  where id=p_treatment_id returning * into t;
 insert into public.treatment_record_events(organization_id,customer_id,treatment_id,actor_id,action,reason,occurred_at,before_data,after_data,operation_id,request_data)
  values(p_organization_id,p_customer_id,p_treatment_id,auth.uid(),'visit_link',p_reason,now_at,to_jsonb(before_row),to_jsonb(t),p_operation_id,request);
 return next t;
end $$;
revoke all on function public.set_treatment_visit_link(uuid,uuid,uuid,uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.set_treatment_visit_link(uuid,uuid,uuid,uuid,uuid,integer,uuid,text) to authenticated;
-- New columns inherit no client INSERT/UPDATE grant; the audited RPC is the only client write path.
commit;
