-- TEAM-11: fixed per-sale-line staff shares for event based commission settlement.
begin;

create table if not exists public.sale_line_commission_allocations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 sale_line_id uuid not null,
 staff_id uuid not null,
 share_basis_points integer not null check (share_basis_points between 1 and 10000),
 created_at timestamptz not null default now(),
 unique (organization_id,id), unique (organization_id,sale_line_id,staff_id),
 foreign key (organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id) on delete restrict,
 foreign key (organization_id,staff_id) references public.appointment_staff(organization_id,id) on delete restrict
);
create index if not exists sale_line_commission_allocations_staff
 on public.sale_line_commission_allocations(organization_id,staff_id,sale_line_id);
alter table public.sale_line_commission_allocations enable row level security;
revoke all on public.sale_line_commission_allocations from public,anon,authenticated;

-- Existing sales retain their current 100% assignment.
insert into public.sale_line_commission_allocations(organization_id,sale_line_id,staff_id,share_basis_points)
select l.organization_id,l.id,s.id,10000
from public.sale_cart_lines l join public.appointment_staff s
 on s.organization_id=l.organization_id and s.is_active and (s.id=l.staff_id or s.auth_user_id=l.staff_id)
on conflict (organization_id,sale_line_id,staff_id) do nothing;

create or replace function private.validate_sale_line_commission_allocation_total() returns trigger
language plpgsql set search_path='' as $$
declare org_id uuid; line_id uuid; allocation_count integer; total_bps integer;
begin
 org_id=coalesce(new.organization_id,old.organization_id);
 line_id=coalesce(new.sale_line_id,old.sale_line_id);
 select count(*),coalesce(sum(a.share_basis_points),0) into allocation_count,total_bps
 from public.sale_line_commission_allocations a where a.organization_id=org_id and a.sale_line_id=line_id;
 if allocation_count>10 or (allocation_count>0 and total_bps<>10000) then
  raise exception 'Commission allocation shares must total 100 percent and include at most 10 staff' using errcode='23514';
 end if;
 return null;
end $$;
drop trigger if exists sale_line_commission_allocations_total on public.sale_line_commission_allocations;
create constraint trigger sale_line_commission_allocations_total after insert or update or delete
 on public.sale_line_commission_allocations deferrable initially deferred
 for each row execute function private.validate_sale_line_commission_allocation_total();

-- Preserve the exact cart envelope and expose canonical staff IDs and percentages.
create or replace function private.sale_cart_payload(p_cart_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('visit',to_jsonb(v),'cart',to_jsonb(c),
  'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('commission_allocations',coalesce((
    select jsonb_agg(jsonb_build_object('staff_id',a.staff_id,'staff_user_id',s.auth_user_id,'staff_name',s.name,'share_basis_points',a.share_basis_points) order by a.staff_id)
    from public.sale_line_commission_allocations a join public.appointment_staff s on s.organization_id=a.organization_id and s.id=a.staff_id
    where a.organization_id=l.organization_id and a.sale_line_id=l.id),'[]'::jsonb)) order by l.created_at,l.id)
   from public.sale_cart_lines l where l.cart_id=c.id),'[]'::jsonb))
 from public.sale_carts c join public.customer_visits v on v.id=c.visit_id where c.id=p_cart_id
$$;
revoke all on function private.sale_cart_payload(uuid) from public,anon,authenticated;

-- Extend the existing idempotent cart mutation. Allocation replacement and line edits
-- remain one transaction and use the same cart version / operation fingerprint.
create or replace function public.mutate_sale_cart_line(
 p_organization_id uuid,p_visit_id uuid,p_line_id uuid,p_expected_version bigint,
 p_operation_id uuid,p_action text,p_values jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype;
 line_row public.sale_cart_lines%rowtype; result jsonb; new_quantity integer; new_price numeric(14,2);
 allocation jsonb; allocation_staff uuid; allocation_count integer; primary_staff uuid;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_line_id is null or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_action is null or p_action not in ('update','remove','restore') or p_values is null or jsonb_typeof(p_values)<>'object'
  then raise exception 'Invalid line mutation' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'line_id',p_line_id,'version',p_expected_version,'action',p_action,'values',p_values)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'mutate_line' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 if cart_row.status not in ('draft','ready') or cart_row.version<>p_expected_version then raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into line_row from public.sale_cart_lines where id=p_line_id and organization_id=p_organization_id and cart_id=cart_row.id for update;
 if not found then raise exception 'Cart line not found' using errcode='P0002'; end if;
 if p_action='update' then
  if line_row.status<>'active' or p_values='{}'::jsonb or p_values - array['quantity','unit_price','staff_id','staff_name','commission_allocations'] <> '{}'::jsonb
   then raise exception 'Invalid line update' using errcode='22023'; end if;
  if (p_values ? 'quantity' and (jsonb_typeof(p_values->'quantity')<>'number' or (p_values->>'quantity') !~ '^[0-9]{1,3}$'))
   or (p_values ? 'unit_price' and (jsonb_typeof(p_values->'unit_price') not in ('number','string') or (p_values->>'unit_price') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$'))
   or (p_values ? 'staff_name' and (jsonb_typeof(p_values->'staff_name')<>'string' or length(p_values->>'staff_name')>200))
   or (p_values ? 'staff_id' and jsonb_typeof(p_values->'staff_id') not in ('string','null'))
   or (p_values ? 'commission_allocations' and jsonb_typeof(p_values->'commission_allocations')<>'array')
   then raise exception 'Invalid line values' using errcode='22023'; end if;
  begin new_quantity=coalesce((p_values->>'quantity')::integer,line_row.quantity); new_price=coalesce((p_values->>'unit_price')::numeric,line_row.unit_price);
  exception when others then raise exception 'Invalid line values' using errcode='22023'; end;
  if new_quantity not between 1 and 999 or new_price::text='NaN' or new_price<0 or new_price>=1000000000000 or new_quantity*new_price>=1000000000000
   then raise exception 'Invalid line values' using errcode='22023'; end if;
  if p_values ? 'staff_id' and p_values->>'staff_id' is not null then
   if (p_values->>'staff_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not exists(select 1 from public.appointment_staff where organization_id=p_organization_id and is_active and (id=(p_values->>'staff_id')::uuid or auth_user_id=(p_values->>'staff_id')::uuid))
    then raise exception 'Invalid staff assignment' using errcode='22023'; end if;
  end if;
  if p_values ? 'commission_allocations' then
   allocation_count=jsonb_array_length(p_values->'commission_allocations');
   if allocation_count>10 then raise exception 'At most 10 staff allocations are allowed' using errcode='22023'; end if;
   if allocation_count>0 and p_values ? 'staff_id' and p_values->>'staff_id' is null then raise exception 'Primary staff is required for commission allocations' using errcode='22023'; end if;
   delete from public.sale_line_commission_allocations where organization_id=p_organization_id and sale_line_id=p_line_id;
   for allocation in select value from jsonb_array_elements(p_values->'commission_allocations') loop
    if jsonb_typeof(allocation)<>'object' or allocation - array['staff_id','share_basis_points']<>'{}'::jsonb
     or jsonb_typeof(allocation->'staff_id')<>'string' or (allocation->>'staff_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(allocation->'share_basis_points')<>'number' or (allocation->>'share_basis_points') !~ '^[0-9]{1,5}$' then
     raise exception 'Invalid commission allocation' using errcode='22023'; end if;
    allocation_staff=(allocation->>'staff_id')::uuid;
    if not exists(select 1 from public.appointment_staff s where s.organization_id=p_organization_id and s.id=allocation_staff and s.is_active) then
     raise exception 'Active staff not found' using errcode='22023'; end if;
    insert into public.sale_line_commission_allocations(organization_id,sale_line_id,staff_id,share_basis_points)
     values(p_organization_id,p_line_id,allocation_staff,(allocation->>'share_basis_points')::integer);
   end loop;
   primary_staff=coalesce(nullif((p_values->>'staff_id'),'')::uuid,line_row.staff_id);
   if allocation_count>0 and not exists(select 1 from public.sale_line_commission_allocations a join public.appointment_staff s on s.organization_id=a.organization_id and s.id=a.staff_id
    where a.organization_id=p_organization_id and a.sale_line_id=p_line_id and (s.id=primary_staff or s.auth_user_id=primary_staff)) then
    raise exception 'Primary staff must be included in the commission allocation' using errcode='22023'; end if;
  elsif p_values ? 'staff_id' then
   delete from public.sale_line_commission_allocations where organization_id=p_organization_id and sale_line_id=p_line_id;
   if p_values->>'staff_id' is not null then
    select s.id into allocation_staff from public.appointment_staff s where s.organization_id=p_organization_id and s.is_active and (s.auth_user_id=(p_values->>'staff_id')::uuid or s.id=(p_values->>'staff_id')::uuid) order by (s.auth_user_id=(p_values->>'staff_id')::uuid) desc limit 1;
    if allocation_staff is not null then insert into public.sale_line_commission_allocations(organization_id,sale_line_id,staff_id,share_basis_points) values(p_organization_id,p_line_id,allocation_staff,10000); end if;
   end if;
  end if;
  update public.sale_cart_lines set quantity=new_quantity,unit_price=new_price,line_total=(new_quantity*new_price)::numeric(14,2),
   staff_id=case when p_values ? 'staff_id' then (p_values->>'staff_id')::uuid else staff_id end,
   staff_name_snapshot=case when p_values ? 'staff_name' then p_values->>'staff_name' else staff_name_snapshot end where id=p_line_id;
 elsif p_action='remove' then
  if line_row.status<>'active' or p_values - 'reason' <> '{}'::jsonb or jsonb_typeof(p_values->'reason')<>'string' or length(btrim(p_values->>'reason')) not between 1 and 1000 then raise exception 'Removal reason required' using errcode='22023'; end if;
  update public.sale_cart_lines set status='removed',removal_reason=btrim(p_values->>'reason'),removed_by=auth.uid(),removed_at=now() where id=p_line_id;
 elsif p_action='restore' then
  if line_row.status<>'removed' or p_values<>'{}'::jsonb then raise exception 'Only removed lines can be restored' using errcode='22023'; end if;
  update public.sale_cart_lines set status='active',removal_reason='',removed_by=null,removed_at=null where id=p_line_id;
 end if;
 perform private.sale_cart_recalculate(cart_row.id);
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'mutate_line',fp,result,now());
 return result;
exception when unique_violation then raise exception 'Source or staff allocation already exists' using errcode='P0001';
end $$;
revoke all on function public.mutate_sale_cart_line(uuid,uuid,uuid,bigint,uuid,text,jsonb) from public,anon;
grant execute on function public.mutate_sale_cart_line(uuid,uuid,uuid,bigint,uuid,text,jsonb) to authenticated;

-- One receipt line may now have a settlement row per employee.
alter table public.staff_commission_settlement_lines drop constraint if exists staff_commission_settlement_lines_organization_id_settlement_id_source_event_id_sale_line_id_key;
alter table public.staff_commission_settlement_lines drop constraint if exists staff_commission_settlement_l_organization_id_settlement_id_key;
alter table public.staff_commission_settlement_lines add constraint staff_commission_settlement_lines_event_line_staff_key
 unique(organization_id,settlement_id,source_event_id,sale_line_id,staff_id);

alter function private.staff_commission_preview(uuid,date,date) rename to staff_commission_preview_before_splits;
create or replace function private.staff_commission_preview(p_organization_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result_lines jsonb:='[]'::jsonb; item jsonb; alloc record; allocs integer; prior_amount numeric; piece numeric;
 target_id uuid; scope text; rule_row record; adjusted jsonb; total_bps integer;
begin
 for item in select value from jsonb_array_elements(private.staff_commission_preview_before_splits(p_organization_id,p_from,p_to)) loop
  select count(*),coalesce(sum(a.share_basis_points),0) into allocs,total_bps from public.sale_line_commission_allocations a
   where a.organization_id=p_organization_id and a.sale_line_id=(item->>'sale_line_id')::uuid;
  if allocs=0 then result_lines=result_lines||jsonb_build_array(item||jsonb_build_object('allocation_basis_points',10000)); continue; end if;
  if total_bps<>10000 then raise exception 'Commission allocation shares are incomplete' using errcode='23514'; end if;
  select coalesce(nullif(l.source_snapshot#>>'{treatment,service_id}','')::uuid,tr.appointment_service_id,l.source_id),
   case when l.source_type='treatment_draft' then 'service' else 'product' end
   into target_id,scope from public.sale_cart_lines l left join public.treatment_sale_drafts d on l.source_type='treatment_draft' and d.organization_id=l.organization_id and d.id=l.source_id
   left join public.treatment_records tr on tr.organization_id=d.organization_id and tr.id=d.treatment_id
   where l.organization_id=p_organization_id and l.id=(item->>'sale_line_id')::uuid;
  prior_amount=0;
  for alloc in select a.staff_id,a.share_basis_points,s.name from public.sale_line_commission_allocations a
   join public.appointment_staff s on s.organization_id=a.organization_id and s.id=a.staff_id
   where a.organization_id=p_organization_id and a.sale_line_id=(item->>'sale_line_id')::uuid order by a.staff_id loop
   if alloc.staff_id=(select a.staff_id from public.sale_line_commission_allocations a where a.organization_id=p_organization_id and a.sale_line_id=(item->>'sale_line_id')::uuid order by a.staff_id desc limit 1) then
    piece=(item->>'net_paid_amount')::numeric-prior_amount;
   else piece=round((item->>'net_paid_amount')::numeric*alloc.share_basis_points/10000.0,0); prior_amount=prior_amount+piece; end if;
   select r.* into rule_row from public.staff_commission_rules r where r.organization_id=p_organization_id and r.staff_id=alloc.staff_id and r.commission_scope=scope
    and (case when scope='service' then r.service_id else r.product_id end)=target_id and r.effective_from<=(item->>'source_event_date')::date and (r.effective_to is null or r.effective_to>=(item->>'source_event_date')::date)
    order by r.effective_from desc,r.created_at desc,r.id limit 1;
   if not found then select r.* into rule_row from public.staff_commission_rules r where r.organization_id=p_organization_id and r.staff_id is null and r.commission_scope=scope
    and (case when scope='service' then r.service_id else r.product_id end)=target_id and r.effective_from<=(item->>'source_event_date')::date and (r.effective_to is null or r.effective_to>=(item->>'source_event_date')::date)
    order by r.effective_from desc,r.created_at desc,r.id limit 1; end if;
   if rule_row.id is null then
    adjusted=item||jsonb_build_object('staff_id',alloc.staff_id,'staff_name_snapshot',alloc.name,'allocation_basis_points',alloc.share_basis_points,'rule_id',null,'rule_rate_basis_points',null,'rule_snapshot',jsonb_build_object('basis','net_paid','allocation_basis_points',alloc.share_basis_points),'net_paid_amount',piece,'commission_amount',0,'warning','적용 수당 규칙 없음');
   else
    adjusted=item||jsonb_build_object('staff_id',alloc.staff_id,'staff_name_snapshot',alloc.name,'allocation_basis_points',alloc.share_basis_points,'rule_id',rule_row.id,'rule_rate_basis_points',rule_row.rate_basis_points,
     'rule_snapshot',jsonb_build_object('effective_from',rule_row.effective_from,'effective_to',rule_row.effective_to,'basis','net_paid','allocation_basis_points',alloc.share_basis_points),
     'net_paid_amount',piece,'commission_amount',round(piece*rule_row.rate_basis_points/10000.0,0),'warning',null);
   end if;
   result_lines=result_lines||jsonb_build_array(adjusted);
  end loop;
 end loop;
 return result_lines;
end $$;
revoke all on function private.staff_commission_preview(uuid,date,date),private.staff_commission_preview_before_splits(uuid,date,date) from public,anon,authenticated;

-- Expose each allocated employee share in the immutable settlement snapshot.
create or replace function public.confirm_staff_commission_settlement(p_organization_id uuid,p_from_date date,p_to_date date,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lines jsonb; v_settlement_id uuid; total numeric(14,0);
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_operation_id is null or p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=((now() at time zone 'Asia/Seoul')::date) or p_to_date-p_from_date>365 then raise exception 'Invalid closed settlement period' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-commission:'||p_organization_id::text||p_from_date::text||p_to_date::text,0));
 select id into v_settlement_id from public.staff_commission_settlements where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if not exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and id=v_settlement_id and from_date=p_from_date and to_date=p_to_date) then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return (select jsonb_build_object('id',s.id,'organization_id',s.organization_id,'from_date',s.from_date,'to_date',s.to_date,'status',s.status,'total_commission',s.total_commission,
   'lines',coalesce(jsonb_agg(jsonb_build_object('source_event_id',l.source_event_id,'source_event_date',l.source_event_date,'event_kind',l.event_kind,'sale_line_id',l.sale_line_id,'staff_id',l.staff_id,'staff_name_snapshot',l.staff_name_snapshot,'commission_scope',l.commission_scope,'source_id',l.source_id,'rule_id',l.rule_id,'rule_rate_basis_points',l.rule_rate_basis_points,'rule_snapshot',l.rule_snapshot,'net_paid_amount',l.net_paid_amount,'commission_amount',l.commission_amount,'warning',case when l.staff_id is null then '담당 직원 미지정' when l.rule_id is null then '적용 수당 규칙 없음' else null end,'allocation_basis_points',coalesce((l.rule_snapshot->>'allocation_basis_points')::integer,10000),'attribution_override_version',coalesce(o.version,0)) order by l.staff_name_snapshot,l.sale_line_id,l.source_event_id) filter(where l.id is not null),'[]'::jsonb))
   from public.staff_commission_settlements s left join public.staff_commission_settlement_lines l on l.organization_id=s.organization_id and l.settlement_id=s.id left join public.staff_commission_attribution_overrides o on o.organization_id=l.organization_id and o.sale_line_id=l.sale_line_id where s.id=v_settlement_id group by s.id);
 end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and daterange(s.from_date,s.to_date+1,'[)') && daterange(p_from_date,p_to_date+1,'[)')) then raise exception 'Commission period overlaps a confirmed settlement' using errcode='23P01'; end if;
 lines=private.staff_commission_preview(p_organization_id,p_from_date,p_to_date);
 if exists(select 1 from jsonb_array_elements(lines) x where x->>'warning' is not null or x->>'staff_id' is null) then raise exception 'Commission assignment or rule is incomplete' using errcode='22023'; end if;
 total=coalesce((select sum((x->>'commission_amount')::numeric) from jsonb_array_elements(lines) x),0);
 insert into public.staff_commission_settlements(organization_id,from_date,to_date,operation_id,status,total_commission,confirmed_by) values(p_organization_id,p_from_date,p_to_date,p_operation_id,'confirmed',total,auth.uid()) returning id into v_settlement_id;
 insert into public.staff_commission_settlement_lines(organization_id,settlement_id,source_event_id,source_event_date,event_kind,sale_line_id,staff_id,staff_name_snapshot,commission_scope,source_id,rule_id,rule_rate_basis_points,rule_snapshot,net_paid_amount,commission_amount)
 select p_organization_id,v_settlement_id,(x->>'source_event_id')::uuid,(x->>'source_event_date')::date,x->>'event_kind',(x->>'sale_line_id')::uuid,(x->>'staff_id')::uuid,x->>'staff_name_snapshot',x->>'commission_scope',(x->>'source_id')::uuid,nullif(x->>'rule_id','')::uuid,nullif(x->>'rule_rate_basis_points','')::integer,x->'rule_snapshot',(x->>'net_paid_amount')::numeric,(x->>'commission_amount')::numeric from jsonb_array_elements(lines) x;
 return jsonb_build_object('id',v_settlement_id,'organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,'status','confirmed','total_commission',total,'lines',lines);
end $$;
revoke all on function public.confirm_staff_commission_settlement(uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.confirm_staff_commission_settlement(uuid,date,date,uuid) to authenticated;

comment on table public.sale_line_commission_allocations is 'Fixed staff shares for each sale line; integer basis points sum to 10000.';
commit;
