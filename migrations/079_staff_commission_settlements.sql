-- TEAM-11: closed-period commission snapshots from net paid sale lines.
begin;

create table if not exists public.staff_commission_settlements (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 from_date date not null, to_date date not null, operation_id uuid not null, status text not null check(status in ('confirmed')),
 total_commission numeric(14,0) not null, confirmed_by uuid not null references auth.users(id),
 confirmed_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,operation_id), unique(organization_id,from_date,to_date),
 check(to_date>=from_date)
);
create table if not exists public.staff_commission_settlement_lines (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, settlement_id uuid not null,
 source_event_id uuid not null, source_event_date date not null, event_kind text not null, sale_line_id uuid not null, staff_id uuid, staff_name_snapshot text not null, commission_scope text not null,
 source_id uuid not null, rule_id uuid, rule_rate_basis_points integer, rule_snapshot jsonb not null,
 net_paid_amount numeric(14,0) not null, commission_amount numeric(14,0) not null,
 created_at timestamptz not null default now(), unique(organization_id,settlement_id,source_event_id,sale_line_id),
 foreign key(organization_id,settlement_id) references public.staff_commission_settlements(organization_id,id) on delete restrict,
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id) on delete restrict,
 foreign key(organization_id,staff_id) references public.appointment_staff(organization_id,id) on delete restrict
);
create index if not exists staff_commission_lines_staff on public.staff_commission_settlement_lines(organization_id,staff_id,settlement_id);
alter table public.staff_commission_settlements enable row level security;
alter table public.staff_commission_settlement_lines enable row level security;
revoke all on public.staff_commission_settlements,public.staff_commission_settlement_lines from public,anon,authenticated;

create or replace function private.staff_commission_preview(p_organization_id uuid,p_from date,p_to date) returns jsonb
language sql stable security definer set search_path='' as $$
 with line_base as (
  select l.id line_id,l.organization_id,l.cart_id,l.source_type,l.source_id,s.id staff_id,
   coalesce(s.name,nullif(l.staff_name_snapshot,''),'미지정') staff_name,
   case when l.source_type='treatment_draft' then 'service' when l.source_type='membership' then 'membership' else 'product' end scope,
   coalesce(nullif(l.source_snapshot#>>'{treatment,service_id}','')::uuid,tr.appointment_service_id,l.source_id) target_id,
   greatest(0,l.line_total-private.sale_cart_line_discount(l.cart_id,l.id)) discounted_amount,
   l.created_at
  from public.sale_cart_lines l left join public.appointment_staff s on s.organization_id=l.organization_id and (s.id=l.staff_id or s.auth_user_id=l.staff_id)
  left join public.treatment_sale_drafts d on l.source_type='treatment_draft' and d.organization_id=l.organization_id and d.id=l.source_id
  left join public.treatment_records tr on tr.organization_id=d.organization_id and tr.id=d.treatment_id
  where l.organization_id=p_organization_id and l.status='active'
 ), paid as (
  select c.id cart_id,r.id event_id,r.amount::numeric(14,0) amount,r.received_at event_at,r.received_at rule_at,'receipt' kind,null::uuid target_line
  from public.visit_payment_receipts r join public.sale_carts c on c.organization_id=r.organization_id and c.id=r.cart_id
  where r.organization_id=p_organization_id and (r.received_at at time zone 'Asia/Seoul')::date between p_from and p_to
  union all
  select c.id,u.id,u.applied_amount,u.created_at,u.created_at,'wallet',u.sale_line_id from public.wallet_usage_ledger u
  join public.sale_carts c on c.organization_id=u.organization_id and c.id=u.cart_id
  where u.organization_id=p_organization_id and u.mode='money' and (u.created_at at time zone 'Asia/Seoul')::date between p_from and p_to
  union all
  select c.id,f.id,-f.amount::numeric(14,0),f.created_at,f.created_at,'refund',coalesce(case when f.source_kind='wallet_usage' then u.sale_line_id end,pr.sale_line_id)
  from public.visit_payment_refunds f join public.sale_carts c on c.organization_id=f.organization_id and c.id=f.cart_id
  left join public.visit_payment_receipts r on r.organization_id=f.organization_id and r.id=f.receipt_id
  left join public.wallet_usage_ledger u on u.organization_id=f.organization_id and u.id=f.wallet_usage_id
  left join public.visit_product_returns pr on pr.organization_id=f.organization_id and pr.operation_id=f.operation_id
  where f.organization_id=p_organization_id and (f.created_at at time zone 'Asia/Seoul')::date between p_from and p_to
 ), weighted as (
  select b.*,p.event_id,p.event_at,p.rule_at,p.kind,p.amount,p.target_line,
   row_number() over(partition by p.event_id order by b.created_at,b.line_id) rn,
   count(*) over(partition by p.event_id) n,
   sum(b.discounted_amount) over(partition by p.event_id) weight_total
  from paid p join line_base b on b.cart_id=p.cart_id and (p.target_line is null or p.target_line=b.line_id)
 ), distributed as (
  select w.*,
   case when target_line is not null then amount
    when weight_total=0 then 0
    when rn=n then amount-coalesce(sum(round(amount*discounted_amount/weight_total,0)) over(partition by event_id order by created_at,line_id rows between unbounded preceding and 1 preceding),0)
    else round(amount*discounted_amount/weight_total,0) end paid_share
  from weighted w
 ), ruled as (
  select d.*,r.id rule_id,r.rate_basis_points,r.effective_from,r.effective_to,
   row_number() over(partition by d.event_id,d.line_id order by (r.staff_id is not null) desc,r.effective_from desc,r.created_at desc,r.id) match_rank
  from distributed d left join public.staff_commission_rules r on r.organization_id=d.organization_id
   and (r.staff_id is null or r.staff_id=d.staff_id) and r.commission_scope=d.scope
   and (case when d.scope='service' then r.service_id else r.product_id end)=d.target_id
   and r.effective_from<=(d.rule_at at time zone 'Asia/Seoul')::date and (r.effective_to is null or r.effective_to>=(d.rule_at at time zone 'Asia/Seoul')::date)
 ), result as (
  select *,paid_share::numeric(14,0) net_paid_amount,round(paid_share*rate_basis_points/10000.0,0)::numeric(14,0) commission_amount
  from ruled where match_rank=1
 )
 select coalesce(jsonb_agg(jsonb_build_object('source_event_id',event_id,'source_event_date',(event_at at time zone 'Asia/Seoul')::date,'event_kind',kind,'sale_line_id',line_id,'staff_id',staff_id,'staff_name_snapshot',staff_name,
  'commission_scope',scope,'source_id',source_id,'rule_id',rule_id,'rule_rate_basis_points',rate_basis_points,
  'rule_snapshot',jsonb_build_object('effective_from',effective_from,'effective_to',effective_to,'basis','net_paid'),
  'net_paid_amount',net_paid_amount,'commission_amount',case when rule_id is null then 0 else commission_amount end,
  'warning',case when staff_id is null then '담당 직원 미지정' when rule_id is null then '적용 수당 규칙 없음' else null end)
  order by staff_name,line_id),'[]'::jsonb) from result
$$;
revoke all on function private.staff_commission_preview(uuid,date,date) from public,anon,authenticated;

create or replace function public.preview_staff_commission_settlement(p_organization_id uuid,p_from_date date,p_to_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=((now() at time zone 'Asia/Seoul')::date) or p_to_date-p_from_date>365 then raise exception 'Only closed periods up to 366 days can be settled' using errcode='22023'; end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and daterange(s.from_date,s.to_date+1,'[)') && daterange(p_from_date,p_to_date+1,'[)')) then raise exception 'Commission period overlaps a confirmed settlement' using errcode='23P01'; end if;
 return jsonb_build_object('organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,'lines',private.staff_commission_preview(p_organization_id,p_from_date,p_to_date));
end $$;

create or replace function public.confirm_staff_commission_settlement(p_organization_id uuid,p_from_date date,p_to_date date,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lines jsonb; v_settlement_id uuid; total numeric(14,0);
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_operation_id is null then raise exception 'Operation ID required' using errcode='22023'; end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>=((now() at time zone 'Asia/Seoul')::date) or p_to_date-p_from_date>365 then raise exception 'Only closed periods up to 366 days can be settled' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-commission:'||p_organization_id::text||p_from_date::text||p_to_date::text,0));
 if exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and operation_id=p_operation_id) then
  select id into v_settlement_id from public.staff_commission_settlements where organization_id=p_organization_id and operation_id=p_operation_id;
  if not exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and id=v_settlement_id and from_date=p_from_date and to_date=p_to_date) then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return (select jsonb_build_object('id',s.id,'organization_id',s.organization_id,'from_date',s.from_date,'to_date',s.to_date,'status',s.status,'total_commission',s.total_commission,'lines',coalesce(jsonb_agg(jsonb_build_object('source_event_id',l.source_event_id,'source_event_date',l.source_event_date,'event_kind',l.event_kind,'sale_line_id',l.sale_line_id,'staff_id',l.staff_id,'staff_name_snapshot',l.staff_name_snapshot,'commission_scope',l.commission_scope,'source_id',l.source_id,'rule_id',l.rule_id,'rule_rate_basis_points',l.rule_rate_basis_points,'rule_snapshot',l.rule_snapshot,'net_paid_amount',l.net_paid_amount,'commission_amount',l.commission_amount,'warning',case when l.staff_id is null then '담당 직원 미지정' when l.rule_id is null then '적용 수당 규칙 없음' else null end) order by l.staff_name_snapshot,l.sale_line_id) filter(where l.id is not null),'[]'::jsonb)) from public.staff_commission_settlements s left join public.staff_commission_settlement_lines l on l.organization_id=s.organization_id and l.settlement_id=s.id where s.id=v_settlement_id group by s.id);
 end if;
 if exists(select 1 from public.staff_commission_settlements where organization_id=p_organization_id and from_date=p_from_date and to_date=p_to_date) then raise exception 'Settlement already confirmed' using errcode='P0001'; end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and daterange(s.from_date,s.to_date+1,'[)') && daterange(p_from_date,p_to_date+1,'[)')) then raise exception 'Commission period overlaps a confirmed settlement' using errcode='23P01'; end if;
 lines=private.staff_commission_preview(p_organization_id,p_from_date,p_to_date);
 if exists(select 1 from jsonb_array_elements(lines) x where x->>'warning' is not null) then raise exception 'Commission assignment or rule is incomplete' using errcode='22023'; end if;
 total=coalesce((select sum((x->>'commission_amount')::numeric) from jsonb_array_elements(lines) x where x->>'rule_id' is not null),0);
 insert into public.staff_commission_settlements(organization_id,from_date,to_date,operation_id,status,total_commission,confirmed_by)
 values(p_organization_id,p_from_date,p_to_date,p_operation_id,'confirmed',total,auth.uid()) returning id into v_settlement_id;
 insert into public.staff_commission_settlement_lines(organization_id,settlement_id,source_event_id,source_event_date,event_kind,sale_line_id,staff_id,staff_name_snapshot,commission_scope,source_id,rule_id,rule_rate_basis_points,rule_snapshot,net_paid_amount,commission_amount)
 select p_organization_id,v_settlement_id,(x->>'source_event_id')::uuid,(x->>'source_event_date')::date,x->>'event_kind',(x->>'sale_line_id')::uuid,nullif(x->>'staff_id','')::uuid,x->>'staff_name_snapshot',x->>'commission_scope',(x->>'source_id')::uuid,nullif(x->>'rule_id','')::uuid,nullif(x->>'rule_rate_basis_points','')::integer,x->'rule_snapshot',(x->>'net_paid_amount')::numeric,(x->>'commission_amount')::numeric from jsonb_array_elements(lines) x;
 return jsonb_build_object('id',v_settlement_id,'organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,'status','confirmed','total_commission',total,'lines',lines);
end $$;

create or replace function public.list_staff_commission_settlements(p_organization_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'Organization access required' using errcode='42501'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object(
   'settlement',jsonb_build_object('id',s.id,'organization_id',s.organization_id,'from_date',s.from_date,'to_date',s.to_date,'status',s.status,'total_commission',case when private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then s.total_commission else (select coalesce(sum(l.commission_amount),0) from public.staff_commission_settlement_lines l join public.appointment_staff st on st.organization_id=l.organization_id and st.id=l.staff_id where l.organization_id=s.organization_id and l.settlement_id=s.id and st.auth_user_id=auth.uid()) end,'confirmed_at',s.confirmed_at),
   'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.staff_name_snapshot,l.sale_line_id) from public.staff_commission_settlement_lines l where l.organization_id=s.organization_id and l.settlement_id=s.id and (private.has_organization_role(p_organization_id,array['owner','admin']::text[]) or l.staff_id in (select st.id from public.appointment_staff st where st.organization_id=p_organization_id and st.auth_user_id=auth.uid()))),'[]'::jsonb)) order by s.from_date desc)
  from public.staff_commission_settlements s where s.organization_id=p_organization_id and (private.has_organization_role(p_organization_id,array['owner','admin']::text[]) or exists(select 1 from public.staff_commission_settlement_lines l join public.appointment_staff st on st.organization_id=l.organization_id and st.id=l.staff_id where l.organization_id=s.organization_id and l.settlement_id=s.id and st.auth_user_id=auth.uid()))),'[]'::jsonb);
end $$;

revoke all on function public.preview_staff_commission_settlement(uuid,date,date),public.confirm_staff_commission_settlement(uuid,date,date,uuid),public.list_staff_commission_settlements(uuid) from public,anon,authenticated;
grant execute on function public.preview_staff_commission_settlement(uuid,date,date),public.confirm_staff_commission_settlement(uuid,date,date,uuid),public.list_staff_commission_settlements(uuid) to authenticated;

-- Add confirmed commission to the operating report, but never label it final while tax is unmodeled.
alter function public.get_management_preview(uuid,date,date) set schema private;
create or replace function public.get_management_preview(p_organization_id uuid,p_from_date date,p_to_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare base jsonb; commission_total numeric(14,0); covered_days integer;
begin
 base=private.get_management_preview(p_organization_id,p_from_date,p_to_date);
 select coalesce((select sum(greatest(0,least(s.to_date,p_to_date)-greatest(s.from_date,p_from_date)+1))::integer from public.staff_commission_settlements s where s.organization_id=p_organization_id and s.from_date<=p_to_date and s.to_date>=p_from_date),0),
  coalesce((select sum(l.commission_amount) from public.staff_commission_settlements s join public.staff_commission_settlement_lines l on l.organization_id=s.organization_id and l.settlement_id=s.id where s.organization_id=p_organization_id and s.from_date<=p_to_date and s.to_date>=p_from_date and l.source_event_date between p_from_date and p_to_date),0)
 into covered_days,commission_total;
 return base||jsonb_build_object(
  'commission_settlement_complete',covered_days=(p_to_date-p_from_date+1),
  'commission_expense',case when covered_days=(p_to_date-p_from_date+1) then commission_total::text else null end,
  'operating_profit_after_commission_before_tax',case when covered_days=(p_to_date-p_from_date+1) and base->>'operating_profit_before_commission_tax' is not null then ((base->>'operating_profit_before_commission_tax')::numeric-commission_total)::text else null end,
  'is_final_profit',false,
  'excluded_costs',case when covered_days=(p_to_date-p_from_date+1) then jsonb_build_array('tax') else jsonb_build_array('staff_commissions','tax') end,
  'staff_basis_is_commission',covered_days=(p_to_date-p_from_date+1));
end $$;
revoke all on function public.get_management_preview(uuid,date,date) from public,anon,authenticated;
grant execute on function public.get_management_preview(uuid,date,date) to authenticated;
commit;
