-- SALE-005: daily settlement snapshots, receivables, and audited close corrections.
begin;

create table if not exists public.visit_daily_closings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 business_date date not null,
 expected_cash numeric(14,0) not null check(expected_cash>-1000000000000 and expected_cash<1000000000000),
 cash_received numeric(14,0) not null check(cash_received>=0),
 cash_refunded numeric(14,0) not null check(cash_refunded>=0),
 card_received numeric(14,0) not null check(card_received>=0),
 card_refunded numeric(14,0) not null check(card_refunded>=0),
 transfer_received numeric(14,0) not null check(transfer_received>=0),
 transfer_refunded numeric(14,0) not null check(transfer_refunded>=0),
 counted_cash numeric(14,0) not null check(counted_cash>=0 and counted_cash<1000000000000),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 operation_id uuid not null,
 closed_by uuid not null references auth.users(id),
 closed_at timestamptz not null default now(),
 unique(organization_id,business_date), unique(organization_id,operation_id), unique(organization_id,id)
);

create table if not exists public.visit_daily_close_adjustments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 closing_id uuid not null, version bigint not null check(version>1),
 previous_counted_cash numeric(14,0) not null check(previous_counted_cash>=0),
 counted_cash numeric(14,0) not null check(counted_cash>=0 and counted_cash<1000000000000),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 operation_id uuid not null, adjusted_by uuid not null references auth.users(id),
 adjusted_at timestamptz not null default now(),
 unique(organization_id,closing_id,version), unique(organization_id,operation_id),
 foreign key(organization_id,closing_id) references public.visit_daily_closings(organization_id,id)
);

create table if not exists public.visit_daily_close_operations (
 organization_id uuid not null references public.organizations(id), operation_id uuid not null,
 actor_id uuid not null references auth.users(id), action text not null check(action in ('close','adjust')),
 request_fingerprint text not null, result_snapshot jsonb not null,
 created_at timestamptz not null default now(), primary key(organization_id,operation_id)
);

do $$ declare t text; begin foreach t in array array['visit_daily_closings','visit_daily_close_adjustments','visit_daily_close_operations'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('drop policy if exists member_select on public.%I',t);
 execute format('create policy member_select on public.%I for select to authenticated using ((select private.has_organization_role(organization_id,array[''owner'',''admin'',''member'']::text[])))',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
end loop; end $$;

drop trigger if exists immutable on public.visit_daily_closings;
create trigger immutable before update or delete on public.visit_daily_closings
 for each row execute function private.prevent_catalog_ledger_change();
drop trigger if exists immutable on public.visit_daily_close_adjustments;
create trigger immutable before update or delete on public.visit_daily_close_adjustments
 for each row execute function private.prevent_catalog_ledger_change();
drop trigger if exists immutable on public.visit_daily_close_operations;
create trigger immutable before update or delete on public.visit_daily_close_operations
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.lock_sale_business_day(p_organization_id uuid,p_business_date date)
returns void language sql volatile security definer set search_path='' as $$
 select pg_advisory_xact_lock(hashtextextended('sale-day:'||p_organization_id::text||':'||p_business_date::text,0))
$$;
revoke all on function private.lock_sale_business_day(uuid,date) from public,anon,authenticated;

create or replace function private.prevent_closed_sale_business_day_entry()
returns trigger language plpgsql security definer set search_path='' as $$
declare business_day date;
begin
 if tg_table_name='visit_payment_receipts' then
  business_day=(new.received_at at time zone 'Asia/Seoul')::date;
 else
  select transaction_date into business_day from public.finance_transactions where id=new.finance_transaction_id;
 end if;
 perform private.lock_sale_business_day(new.organization_id,business_day);
 if exists(select 1 from public.visit_daily_closings c where c.organization_id=new.organization_id and c.business_date=business_day) then
  raise exception 'Business day is closed' using errcode='P0001';
 end if;
 return new;
end $$;
revoke all on function private.prevent_closed_sale_business_day_entry() from public,anon,authenticated;
drop trigger if exists visit_payment_receipts_open_day on public.visit_payment_receipts;
create trigger visit_payment_receipts_open_day before insert on public.visit_payment_receipts
 for each row execute function private.prevent_closed_sale_business_day_entry();
drop trigger if exists visit_payment_refunds_open_day on public.visit_payment_refunds;
create trigger visit_payment_refunds_open_day before insert on public.visit_payment_refunds
 for each row when(new.source_kind='receipt') execute function private.prevent_closed_sale_business_day_entry();

create or replace function private.sale_daily_snapshot(p_organization_id uuid,p_business_date date)
returns jsonb language sql stable security definer set search_path='' as $$
 with received as (
  select coalesce(sum(amount) filter(where method='cash'),0) cash,
   coalesce(sum(amount) filter(where method='card'),0) card,
   coalesce(sum(amount) filter(where method='transfer'),0) transfer,
   count(*)::int count
  from public.visit_payment_receipts r
  where r.organization_id=p_organization_id and (r.received_at at time zone 'Asia/Seoul')::date=p_business_date
 ), refunded as (
  select coalesce(sum(f.amount) filter(where r.method='cash'),0) cash,
   coalesce(sum(f.amount) filter(where r.method='card'),0) card,
   coalesce(sum(f.amount) filter(where r.method='transfer'),0) transfer,
   count(*)::int count
  from public.visit_payment_refunds f join public.visit_payment_receipts r on r.id=f.receipt_id
  where f.organization_id=p_organization_id and (f.created_at at time zone 'Asia/Seoul')::date=p_business_date
 ), receivable_rows as (
  select c.id cart_id,c.visit_id,c.customer_id,v.name customer_name,c.total_amount,
   greatest(c.total_amount-coalesce(p.received,0)+coalesce(p.refunded,0),0) due_amount,
   coalesce(p.received,0) received_amount,coalesce(p.refunded,0) refunded_amount
  from public.sale_carts c join public.customer_visits cv on cv.id=c.visit_id
  join public.customers v on v.id=c.customer_id
  left join lateral (select sum(r.amount) received from public.visit_payment_receipts r where r.cart_id=c.id) a on true
  left join lateral (select sum(u.applied_amount) received from public.wallet_usage_ledger u where u.cart_id=c.id) w on true
  left join lateral (select coalesce(a.received,0)+coalesce(w.received,0) received,
    (select sum(f.amount) from public.visit_payment_refunds f where f.cart_id=c.id) refunded) p on true
  where c.organization_id=p_organization_id and c.status='collecting'
 ), close_row as (
  select cl.*,coalesce(adj.counted_cash,cl.counted_cash) current_counted_cash,
   coalesce(adj.version,1) current_version
  from public.visit_daily_closings cl left join lateral (select counted_cash,version from public.visit_daily_close_adjustments
   where organization_id=cl.organization_id and closing_id=cl.id order by version desc limit 1) adj on true
  where cl.organization_id=p_organization_id and cl.business_date=p_business_date
 )
 select jsonb_build_object('organization_id',p_organization_id,'business_date',p_business_date,
  'cash_received',received.cash,'cash_refunded',refunded.cash,'expected_cash',received.cash-refunded.cash,
  'card_received',received.card,'card_refunded',refunded.card,
  'transfer_received',received.transfer,'transfer_refunded',refunded.transfer,
  'receipt_count',received.count,'refund_count',refunded.count,
  'receivables',coalesce((select jsonb_agg(jsonb_build_object('cart_id',r.cart_id,'visit_id',r.visit_id,'customer_id',r.customer_id,
   'customer_name',r.customer_name,'total_amount',r.total_amount,'received_amount',r.received_amount,
   'refunded_amount',r.refunded_amount,'due_amount',r.due_amount) order by r.customer_name,r.cart_id) from receivable_rows r),'[]'::jsonb),
  'is_closed',close_row.id is not null,
  'close',case when close_row.id is null then null else jsonb_build_object('id',close_row.id,'version',close_row.current_version,
   'expected_cash',close_row.expected_cash,'counted_cash',close_row.current_counted_cash,
   'variance',close_row.current_counted_cash-close_row.expected_cash,'reason',close_row.reason,
   'closed_by',close_row.closed_by,'closed_at',close_row.closed_at,
   'adjustments',coalesce((select jsonb_agg(jsonb_build_object('version',a.version,'previous_counted_cash',a.previous_counted_cash,
   'counted_cash',a.counted_cash,'reason',a.reason,'adjusted_by',a.adjusted_by,'adjusted_at',a.adjusted_at) order by a.version)
   from public.visit_daily_close_adjustments a where a.closing_id=close_row.id),'[]'::jsonb)) end)
 from received,refunded left join close_row on true
$$;
revoke all on function private.sale_daily_snapshot(uuid,date) from public,anon,authenticated;

create or replace function public.get_sale_daily_settlement(p_organization_id uuid,p_business_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or p_business_date is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[])
 then raise exception 'Daily settlement read permission required' using errcode='42501'; end if;
 return private.sale_daily_snapshot(p_organization_id,p_business_date);
end $$;
revoke all on function public.get_sale_daily_settlement(uuid,date) from public,anon,authenticated;
grant execute on function public.get_sale_daily_settlement(uuid,date) to authenticated;

create or replace function public.close_sale_daily(p_organization_id uuid,p_business_date date,p_counted_cash text,p_reason text,p_operation_id uuid,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.visit_daily_close_operations%rowtype;expected numeric(14,0);cash_in numeric(14,0);cash_out numeric(14,0);card_in numeric(14,0);card_out numeric(14,0);transfer_in numeric(14,0);transfer_out numeric(14,0);id_value uuid;result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_business_date is null or p_business_date>(now() at time zone 'Asia/Seoul')::date or p_operation_id is null or p_confirmed is distinct from true or p_counted_cash !~ '^(0|[1-9][0-9]{0,11})$' or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Invalid daily close' using errcode='22023'; end if;
 perform private.lock_sale_business_day(p_organization_id,p_business_date);
 fp=md5(jsonb_build_object('date',p_business_date,'cash',p_counted_cash,'reason',btrim(p_reason),'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-close-op:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.visit_daily_close_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'close' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select coalesce(sum(amount) filter(where method='cash'),0),coalesce(sum(amount) filter(where method='card'),0),coalesce(sum(amount) filter(where method='transfer'),0)
 into cash_in,card_in,transfer_in from public.visit_payment_receipts where organization_id=p_organization_id and (received_at at time zone 'Asia/Seoul')::date=p_business_date;
 select coalesce(sum(f.amount) filter(where r.method='cash'),0),coalesce(sum(f.amount) filter(where r.method='card'),0),coalesce(sum(f.amount) filter(where r.method='transfer'),0)
 into cash_out,card_out,transfer_out from public.visit_payment_refunds f join public.visit_payment_receipts r on r.id=f.receipt_id
 where f.organization_id=p_organization_id and (f.created_at at time zone 'Asia/Seoul')::date=p_business_date;
 expected=cash_in-cash_out;
 insert into public.visit_daily_closings(organization_id,business_date,expected_cash,cash_received,cash_refunded,card_received,card_refunded,transfer_received,transfer_refunded,counted_cash,reason,operation_id,closed_by)
 values(p_organization_id,p_business_date,expected,cash_in,cash_out,card_in,card_out,transfer_in,transfer_out,p_counted_cash::numeric,btrim(p_reason),p_operation_id,auth.uid()) returning id into id_value;
 result=private.sale_daily_snapshot(p_organization_id,p_business_date);
 insert into public.visit_daily_close_operations values(p_organization_id,p_operation_id,auth.uid(),'close',fp,result,now());
 return result;
end $$;
revoke all on function public.close_sale_daily(uuid,date,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.close_sale_daily(uuid,date,text,text,uuid,boolean) to authenticated;

create or replace function public.adjust_sale_daily_close(p_organization_id uuid,p_business_date date,p_expected_version bigint,p_counted_cash text,p_reason text,p_operation_id uuid,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.visit_daily_close_operations%rowtype;closing public.visit_daily_closings%rowtype;current_cash numeric(14,0);current_version bigint;result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_business_date is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null or p_confirmed is distinct from true or p_counted_cash !~ '^(0|[1-9][0-9]{0,11})$' or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Invalid daily close adjustment' using errcode='22023'; end if;
 perform private.lock_sale_business_day(p_organization_id,p_business_date);
 fp=md5(jsonb_build_object('date',p_business_date,'version',p_expected_version,'cash',p_counted_cash,'reason',btrim(p_reason),'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-close-op:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.visit_daily_close_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'adjust' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into closing from public.visit_daily_closings where organization_id=p_organization_id and business_date=p_business_date for update;
 if not found then raise exception 'Daily close not found' using errcode='P0002'; end if;
 select coalesce(max(version),1),coalesce((array_agg(counted_cash order by version desc))[1],closing.counted_cash) into current_version,current_cash from public.visit_daily_close_adjustments where closing_id=closing.id;
 if current_version<>p_expected_version then raise exception 'Daily close changed' using errcode='P0001'; end if;
 insert into public.visit_daily_close_adjustments(organization_id,closing_id,version,previous_counted_cash,counted_cash,reason,operation_id,adjusted_by)
 values(p_organization_id,closing.id,current_version+1,current_cash,p_counted_cash::numeric,btrim(p_reason),p_operation_id,auth.uid());
 result=private.sale_daily_snapshot(p_organization_id,p_business_date);
 insert into public.visit_daily_close_operations values(p_organization_id,p_operation_id,auth.uid(),'adjust',fp,result,now());
 return result;
end $$;
revoke all on function public.adjust_sale_daily_close(uuid,date,bigint,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.adjust_sale_daily_close(uuid,date,bigint,text,text,uuid,boolean) to authenticated;

commit;
