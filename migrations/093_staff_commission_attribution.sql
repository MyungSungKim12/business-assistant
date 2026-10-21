-- TEAM-11: manager-attributed staff for previously unassigned sale lines.
begin;

create table if not exists public.staff_commission_attribution_overrides (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 sale_line_id uuid not null, staff_id uuid not null, reason text not null check(length(btrim(reason)) between 1 and 500),
 version integer not null check(version>0), operation_id uuid not null, changed_by uuid not null references auth.users(id), changed_at timestamptz not null default now(),
 unique(organization_id,sale_line_id), unique(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id) on delete restrict,
 foreign key(organization_id,staff_id) references public.appointment_staff(organization_id,id) on delete restrict
);
create table if not exists public.staff_commission_attribution_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), override_id uuid not null,
 sale_line_id uuid not null, previous_staff_id uuid, staff_id uuid not null, previous_version integer not null, version integer not null,
 reason text not null, operation_id uuid not null, fingerprint text not null, actor_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(organization_id,operation_id), unique(organization_id,override_id,version),
 foreign key(organization_id,override_id) references public.staff_commission_attribution_overrides(organization_id,id) on delete restrict,
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id) on delete restrict,
 foreign key(organization_id,previous_staff_id) references public.appointment_staff(organization_id,id) on delete restrict,
 foreign key(organization_id,staff_id) references public.appointment_staff(organization_id,id) on delete restrict
);
alter table public.staff_commission_attribution_overrides enable row level security;
alter table public.staff_commission_attribution_events enable row level security;
revoke all on public.staff_commission_attribution_overrides,public.staff_commission_attribution_events from public,anon,authenticated;

create or replace function private.reject_commission_attribution_event_change() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'Commission attribution history is immutable' using errcode='55000'; end $$;
drop trigger if exists staff_commission_attribution_events_immutable on public.staff_commission_attribution_events;
create trigger staff_commission_attribution_events_immutable before update or delete on public.staff_commission_attribution_events
 for each row execute function private.reject_commission_attribution_event_change();

create or replace function public.assign_staff_commission_attribution(
 p_organization_id uuid,p_sale_line_id uuid,p_staff_id uuid,p_expected_version integer,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.staff_commission_attribution_events%rowtype; current_row public.staff_commission_attribution_overrides%rowtype;
 line_row public.sale_cart_lines%rowtype; staff_row public.appointment_staff%rowtype; fp text; new_version integer; result jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_sale_line_id is null or p_staff_id is null or p_expected_version is null or p_expected_version<0 or p_operation_id is null or p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'Invalid commission attribution' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('organization',p_organization_id,'line',p_sale_line_id,'staff',p_staff_id,'version',p_expected_version,'reason',btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('commission-attribution-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.staff_commission_attribution_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  select * into current_row from public.staff_commission_attribution_overrides where organization_id=p_organization_id and sale_line_id=p_sale_line_id;
  return jsonb_build_object('organization_id',p_organization_id,'sale_line_id',p_sale_line_id,'staff_id',prior.staff_id,'version',prior.version,'reason',prior.reason,'replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('commission-attribution-line:'||p_organization_id::text||p_sale_line_id::text,0));
 select * into line_row from public.sale_cart_lines where organization_id=p_organization_id and id=p_sale_line_id and status='active' for update;
 if not found then raise exception 'Sale line not found' using errcode='P0002'; end if;
 if exists(select 1 from public.staff_commission_settlement_lines where organization_id=p_organization_id and sale_line_id=p_sale_line_id) then raise exception 'Commission attribution is frozen by a confirmed settlement' using errcode='55000'; end if;
 if exists(select 1 from public.appointment_staff s where s.organization_id=p_organization_id and s.is_active and (s.id=line_row.staff_id or s.auth_user_id=line_row.staff_id)) then raise exception 'Sale line already has a valid staff assignment' using errcode='22023'; end if;
 select * into staff_row from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id and is_active for share;
 if not found then raise exception 'Active staff not found' using errcode='P0002'; end if;
 select * into current_row from public.staff_commission_attribution_overrides where organization_id=p_organization_id and sale_line_id=p_sale_line_id for update;
 if found then
  if current_row.version<>p_expected_version then raise exception 'Attribution changed' using errcode='P0001'; end if;
  new_version=current_row.version+1;
  update public.staff_commission_attribution_overrides set staff_id=p_staff_id,reason=btrim(p_reason),version=new_version,operation_id=p_operation_id,changed_by=auth.uid(),changed_at=now()
   where organization_id=p_organization_id and sale_line_id=p_sale_line_id returning * into current_row;
 else
  if p_expected_version<>0 then raise exception 'Attribution changed' using errcode='P0001'; end if;
  new_version=1;
  insert into public.staff_commission_attribution_overrides(organization_id,sale_line_id,staff_id,reason,version,operation_id,changed_by)
   values(p_organization_id,p_sale_line_id,p_staff_id,btrim(p_reason),new_version,p_operation_id,auth.uid()) returning * into current_row;
 end if;
 insert into public.staff_commission_attribution_events(organization_id,override_id,sale_line_id,previous_staff_id,staff_id,previous_version,version,reason,operation_id,fingerprint,actor_id)
 values(p_organization_id,current_row.id,p_sale_line_id,nullif((select e.staff_id::text from public.staff_commission_attribution_events e where e.organization_id=p_organization_id and e.sale_line_id=p_sale_line_id order by e.version desc limit 1), '')::uuid,p_staff_id,new_version-1,new_version,btrim(p_reason),p_operation_id,fp,auth.uid());
 result=jsonb_build_object('organization_id',p_organization_id,'sale_line_id',p_sale_line_id,'staff_id',p_staff_id,'version',new_version,'reason',btrim(p_reason),'replayed',false);
 return result;
end $$;
revoke all on function public.assign_staff_commission_attribution(uuid,uuid,uuid,integer,text,uuid) from public,anon;
grant execute on function public.assign_staff_commission_attribution(uuid,uuid,uuid,integer,text,uuid) to authenticated;

create or replace function public.list_staff_commission_attribution_staff(p_organization_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'organization_id',s.organization_id,'name',s.name,'is_active',s.is_active) order by s.name,s.id) from public.appointment_staff s where s.organization_id=p_organization_id and s.is_active),'[]'::jsonb);
end $$;
revoke all on function public.list_staff_commission_attribution_staff(uuid) from public,anon;
grant execute on function public.list_staff_commission_attribution_staff(uuid) to authenticated;

-- Preserve the 079 calculation, then replace only rows with a manager attribution.
alter function private.staff_commission_preview(uuid,date,date) rename to staff_commission_preview_before_attribution;
create or replace function private.staff_commission_preview(p_organization_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result_lines jsonb:='[]'::jsonb; item jsonb; ov record; staff_name text; target_id uuid; rule_row record; adjusted jsonb;
begin
 for item in select value from jsonb_array_elements(private.staff_commission_preview_before_attribution(p_organization_id,p_from,p_to)) loop
  select o.staff_id,o.version into ov from public.staff_commission_attribution_overrides o
   where o.organization_id=p_organization_id and o.sale_line_id=(item->>'sale_line_id')::uuid;
  if not found then
   result_lines=result_lines||jsonb_build_array(item||jsonb_build_object('attribution_override_version',0));
   continue;
  end if;
  select s.name into staff_name from public.appointment_staff s where s.organization_id=p_organization_id and s.id=ov.staff_id and s.is_active;
  select coalesce(nullif(l.source_snapshot#>>'{treatment,service_id}','')::uuid,tr.appointment_service_id,l.source_id) into target_id
   from public.sale_cart_lines l left join public.treatment_sale_drafts d on l.source_type='treatment_draft' and d.organization_id=l.organization_id and d.id=l.source_id
   left join public.treatment_records tr on tr.organization_id=d.organization_id and tr.id=d.treatment_id
   where l.organization_id=p_organization_id and l.id=(item->>'sale_line_id')::uuid;
  select r.* into rule_row from public.staff_commission_rules r where r.organization_id=p_organization_id and r.staff_id=ov.staff_id
   and r.commission_scope=item->>'commission_scope'
   and (case when r.commission_scope='service' then r.service_id else r.product_id end)=target_id
   and r.effective_from<=(item->>'source_event_date')::date and (r.effective_to is null or r.effective_to>=(item->>'source_event_date')::date)
   order by r.effective_from desc,r.created_at desc,r.id limit 1;
  if not found then
   select r.* into rule_row from public.staff_commission_rules r where r.organization_id=p_organization_id and r.staff_id is null
    and r.commission_scope=item->>'commission_scope'
    and (case when r.commission_scope='service' then r.service_id else r.product_id end)=target_id
    and r.effective_from<=(item->>'source_event_date')::date and (r.effective_to is null or r.effective_to>=(item->>'source_event_date')::date)
    order by r.effective_from desc,r.created_at desc,r.id limit 1;
  end if;
  if rule_row.id is null then
   adjusted=item||jsonb_build_object('staff_id',ov.staff_id,'staff_name_snapshot',coalesce(staff_name,'담당 직원'),'rule_id',null,'rule_rate_basis_points',null,'rule_snapshot',jsonb_build_object('basis','net_paid'),'commission_amount',0,'warning','적용 수당 규칙 없음','attribution_override_version',ov.version);
  else
   adjusted=item||jsonb_build_object('staff_id',ov.staff_id,'staff_name_snapshot',coalesce(staff_name,'담당 직원'),'rule_id',rule_row.id,'rule_rate_basis_points',rule_row.rate_basis_points,
    'rule_snapshot',jsonb_build_object('effective_from',rule_row.effective_from,'effective_to',rule_row.effective_to,'basis','net_paid'),
    'commission_amount',round((item->>'net_paid_amount')::numeric*rule_row.rate_basis_points/10000.0,0),'warning',null,'attribution_override_version',ov.version);
  end if;
  result_lines=result_lines||jsonb_build_array(adjusted);
 end loop;
 return result_lines;
end $$;
revoke all on function private.staff_commission_preview(uuid,date,date),private.staff_commission_preview_before_attribution(uuid,date,date) from public,anon,authenticated;

-- Return the same preview shape on operation replay, including attribution versions.
create or replace function public.confirm_staff_commission_settlement(p_organization_id uuid,p_from_date date,p_to_date date,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lines jsonb; v_settlement_id uuid; total numeric(14,0);
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_operation_id is null then raise exception 'Operation ID required' using errcode='22023'; end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=((now() at time zone 'Asia/Seoul')::date) or p_to_date-p_from_date>365 then raise exception 'Only closed periods up to 366 days can be settled' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-commission:'||p_organization_id::text||p_from_date::text||p_to_date::text,0));
 select id into v_settlement_id from public.staff_commission_settlements where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if not exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and id=v_settlement_id and from_date=p_from_date and to_date=p_to_date) then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return (select jsonb_build_object('id',s.id,'organization_id',s.organization_id,'from_date',s.from_date,'to_date',s.to_date,'status',s.status,'total_commission',s.total_commission,
   'lines',coalesce(jsonb_agg(jsonb_build_object('source_event_id',l.source_event_id,'source_event_date',l.source_event_date,'event_kind',l.event_kind,'sale_line_id',l.sale_line_id,'staff_id',l.staff_id,'staff_name_snapshot',l.staff_name_snapshot,'commission_scope',l.commission_scope,'source_id',l.source_id,'rule_id',l.rule_id,'rule_rate_basis_points',l.rule_rate_basis_points,'rule_snapshot',l.rule_snapshot,'net_paid_amount',l.net_paid_amount,'commission_amount',l.commission_amount,'warning',case when l.staff_id is null then '담당 직원 미지정' when l.rule_id is null then '적용 수당 규칙 없음' else null end,'attribution_override_version',coalesce(o.version,0)) order by l.staff_name_snapshot,l.sale_line_id) filter(where l.id is not null),'[]'::jsonb))
   from public.staff_commission_settlements s left join public.staff_commission_settlement_lines l on l.organization_id=s.organization_id and l.settlement_id=s.id left join public.staff_commission_attribution_overrides o on o.organization_id=l.organization_id and o.sale_line_id=l.sale_line_id where s.id=v_settlement_id group by s.id);
 end if;
 if exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and from_date=p_from_date and to_date=p_to_date) then raise exception 'Settlement already confirmed' using errcode='P0001'; end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and daterange(s.from_date,s.to_date+1,'[)') && daterange(p_from_date,p_to_date+1,'[)')) then raise exception 'Commission period overlaps a confirmed settlement' using errcode='23P01'; end if;
 lines=private.staff_commission_preview(p_organization_id,p_from_date,p_to_date);
 if exists(select 1 from jsonb_array_elements(lines) x where x->>'warning' is not null) then raise exception 'Commission assignment or rule is incomplete' using errcode='22023'; end if;
 total=coalesce((select sum((x->>'commission_amount')::numeric) from jsonb_array_elements(lines) x where x->>'rule_id' is not null),0);
 insert into public.staff_commission_settlements(organization_id,from_date,to_date,operation_id,status,total_commission,confirmed_by) values(p_organization_id,p_from_date,p_to_date,p_operation_id,'confirmed',total,auth.uid()) returning id into v_settlement_id;
 insert into public.staff_commission_settlement_lines(organization_id,settlement_id,source_event_id,source_event_date,event_kind,sale_line_id,staff_id,staff_name_snapshot,commission_scope,source_id,rule_id,rule_rate_basis_points,rule_snapshot,net_paid_amount,commission_amount)
 select p_organization_id,v_settlement_id,(x->>'source_event_id')::uuid,(x->>'source_event_date')::date,x->>'event_kind',(x->>'sale_line_id')::uuid,nullif(x->>'staff_id','')::uuid,x->>'staff_name_snapshot',x->>'commission_scope',(x->>'source_id')::uuid,nullif(x->>'rule_id','')::uuid,nullif(x->>'rule_rate_basis_points','')::integer,x->'rule_snapshot',(x->>'net_paid_amount')::numeric,(x->>'commission_amount')::numeric from jsonb_array_elements(lines) x;
 return jsonb_build_object('id',v_settlement_id,'organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,'status','confirmed','total_commission',total,'lines',lines);
end $$;
revoke all on function public.confirm_staff_commission_settlement(uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.confirm_staff_commission_settlement(uuid,date,date,uuid) to authenticated;

comment on table public.staff_commission_attribution_overrides is 'Manager corrections for unassigned commission sale lines; source sale line remains unchanged.';
comment on table public.staff_commission_attribution_events is 'Immutable audit events for commission staff attribution changes.';
commit;
