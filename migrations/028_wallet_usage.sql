-- WAL-002: atomic membership wallet usage applied to treatment sale lines.
begin;

create table if not exists public.wallet_usage_ledger (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 wallet_id uuid not null,
 cart_id uuid not null,
 visit_id uuid not null,
 sale_line_id uuid not null,
 operation_id uuid not null,
 mode text not null check(mode in ('money','count')),
 money_delta numeric(12,0) not null check(money_delta<=0 and money_delta>-1000000000000),
 count_delta integer not null check(count_delta in (-1,0)),
 applied_amount numeric(14,0) not null check(applied_amount>0 and applied_amount<1000000000000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,operation_id),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 foreign key(organization_id,cart_id,visit_id) references public.sale_carts(organization_id,id,visit_id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id),
 check((mode='money' and money_delta<0 and count_delta=0 and applied_amount=-money_delta)
    or (mode='count' and money_delta=0 and count_delta=-1))
);
create index if not exists wallet_usage_wallet_time
 on public.wallet_usage_ledger(organization_id,wallet_id,created_at,id);
create index if not exists wallet_usage_cart_time
 on public.wallet_usage_ledger(organization_id,cart_id,created_at,id);
create unique index if not exists wallet_usage_count_line
 on public.wallet_usage_ledger(organization_id,sale_line_id) where mode='count';

alter table public.wallet_usage_ledger enable row level security;
drop policy if exists wallet_usage_member_select on public.wallet_usage_ledger;
create policy wallet_usage_member_select on public.wallet_usage_ledger for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.wallet_usage_ledger from public,anon,authenticated;
grant select on public.wallet_usage_ledger to authenticated;
drop trigger if exists immutable on public.wallet_usage_ledger;
create trigger immutable before update or delete on public.wallet_usage_ledger
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.visit_payment_payload(p_cart_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'visit_id',c.visit_id,'cart_id',c.id,'cart_version',c.version,
  'total_amount',c.total_amount,'paid_amount',coalesce(p.paid_amount,0),
  'outstanding_amount',c.total_amount-coalesce(p.paid_amount,0),
  'currency','KRW','status',c.status,'receipts',coalesce(p.receipts,'[]'::jsonb)
 )
 from public.sale_carts c
 left join lateral (
  select sum(x.amount) paid_amount,
   jsonb_agg(jsonb_build_object('id',x.id,'method',x.method,'amount',x.amount,
    'reference',x.reference,'received_at',x.received_at,'operation_id',x.operation_id)
    order by x.received_at,x.id) receipts
  from (
   select r.id,r.method,r.amount,r.reference,r.received_at,r.operation_id
   from public.visit_payment_receipts r where r.cart_id=c.id
   union all
   select u.id,'wallet'::text,u.applied_amount,
    w.name_snapshot||case when u.mode='count' then ' · 1회' else ' · 금액' end,
    u.created_at,u.operation_id
   from public.wallet_usage_ledger u join public.customer_wallets w on w.id=u.wallet_id
   where u.cart_id=c.id
  ) x
 ) p on true
 where c.id=p_cart_id
$$;

create or replace function public.list_customer_wallets(p_organization_id uuid,p_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']) then raise exception 'Wallet read permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.customers where organization_id=p_organization_id and id=p_customer_id) then raise exception 'Customer not found' using errcode='P0002'; end if;
 return coalesce((select jsonb_agg(
  to_jsonb(w)||jsonb_build_object('money_balance',w.money_balance::text,'usage_history',
   coalesce((select jsonb_agg(jsonb_build_object(
    'id',u.id,'visit_id',u.visit_id,'sale_line_id',u.sale_line_id,'mode',u.mode,
    'money_delta',u.money_delta::text,'count_delta',u.count_delta,
    'applied_amount',u.applied_amount::text,'created_at',u.created_at
   ) order by u.created_at desc,u.id desc) from public.wallet_usage_ledger u where u.wallet_id=w.id),'[]'::jsonb))
  order by w.created_at,w.id)
 from public.customer_wallets w where organization_id=p_organization_id and customer_id=p_customer_id),'[]'::jsonb);
end $$;

create or replace function public.use_customer_wallet(
 p_organization_id uuid,p_visit_id uuid,p_wallet_id uuid,p_sale_line_id uuid,
 p_mode text,p_amount text,p_expected_cart_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype;
 visit_row public.customer_visits%rowtype; wallet_row public.customer_wallets%rowtype;
 line_row public.sale_cart_lines%rowtype; requested numeric(12,0); applied numeric(14,0);
 paid numeric(14,0); outstanding numeric(14,0); line_used numeric(14,0); line_remaining numeric(14,0); result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_wallet_id is null or p_sale_line_id is null or p_operation_id is null
  or p_expected_cart_version is null or p_expected_cart_version<1 or p_confirmed is distinct from true
  or p_mode not in ('money','count')
  or (p_mode='money' and (p_amount is null or p_amount!~'^[1-9][0-9]{0,11}$'))
  or (p_mode='count' and p_amount is not null)
 then raise exception 'Invalid wallet usage request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit',p_visit_id,'wallet',p_wallet_id,'line',p_sale_line_id,
  'mode',p_mode,'amount',p_amount,'version',p_expected_cart_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'use_wallet' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_cart_version or cart_row.status not in ('ready','collecting') or visit_row.status<>'checkout_ready'
 then raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into wallet_row from public.customer_wallets where organization_id=p_organization_id and id=p_wallet_id for update;
 if not found or wallet_row.customer_id<>cart_row.customer_id then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if wallet_row.valid_from>(now() at time zone 'Asia/Seoul')::date
  or (wallet_row.expires_on is not null and wallet_row.expires_on<(now() at time zone 'Asia/Seoul')::date)
 then raise exception 'Wallet is not currently valid' using errcode='P0001'; end if;
 select * into line_row from public.sale_cart_lines where organization_id=p_organization_id and id=p_sale_line_id and cart_id=cart_row.id for update;
 if not found or line_row.status<>'active' or line_row.source_type<>'treatment_draft' then raise exception 'Active treatment line required' using errcode='22023'; end if;
 select coalesce(sum(amount),0)+(select coalesce(sum(applied_amount),0) from public.wallet_usage_ledger where cart_id=cart_row.id)
 into paid from public.visit_payment_receipts where cart_id=cart_row.id;
 outstanding=cart_row.total_amount-paid;
 select coalesce(sum(applied_amount),0) into line_used from public.wallet_usage_ledger where sale_line_id=line_row.id;
 line_remaining=line_row.line_total-line_used;
 if outstanding<=0 or line_remaining<=0 then raise exception 'No remaining amount for wallet usage' using errcode='P0001'; end if;
 if p_mode='money' then
  requested=p_amount::numeric(12,0);
  if wallet_row.money_balance<requested or requested>outstanding or requested>line_remaining then raise exception 'Insufficient wallet or applicable balance' using errcode='P0001'; end if;
  applied=requested;
  update public.customer_wallets set money_balance=money_balance-requested where id=wallet_row.id;
 else
  if wallet_row.count_balance<1 or line_remaining>outstanding or exists(select 1 from public.wallet_usage_ledger where organization_id=p_organization_id and sale_line_id=line_row.id and mode='count')
  then raise exception 'Count benefit is unavailable for this line' using errcode='P0001'; end if;
  applied=line_remaining;
  update public.customer_wallets set count_balance=count_balance-1 where id=wallet_row.id;
 end if;
 insert into public.wallet_usage_ledger(organization_id,wallet_id,cart_id,visit_id,sale_line_id,operation_id,mode,money_delta,count_delta,applied_amount,created_by)
 values(p_organization_id,wallet_row.id,cart_row.id,p_visit_id,line_row.id,p_operation_id,p_mode,
  case when p_mode='money' then -requested else 0 end,case when p_mode='count' then -1 else 0 end,applied,auth.uid());
 update public.sale_carts set status=case when paid+applied=total_amount then 'paid' else 'collecting' end,
  version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 if paid+applied=cart_row.total_amount then
  update public.customer_visits set status='closed',closed_at=now(),version=version+1,updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 end if;
 result=private.visit_payment_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'use_wallet',fp,result);
 return result;
end $$;

-- External receipts must include earlier wallet usages when checking the
-- outstanding balance and deciding whether the visit is fully paid.
create or replace function public.record_visit_payment(
 p_organization_id uuid,p_visit_id uuid,p_expected_version bigint,p_operation_id uuid,
 p_payments jsonb,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype;
 cart_row public.sale_carts%rowtype; visit_row public.customer_visits%rowtype;
 item jsonb; method_value text; amount_value numeric(14,0); reference_value text;
 payment_total numeric(14,0):=0; already_paid numeric(14,0); finance_id uuid; result jsonb;
 seen_methods text[]:=array[]::text[];
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_confirmed is distinct from true
  or p_payments is null or jsonb_typeof(p_payments)<>'array'
  or jsonb_array_length(p_payments) not between 1 and 3
 then raise exception 'Invalid payment request' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_payments) as elements(value) loop
  if jsonb_typeof(item)<>'object' or not(item ?& array['method','amount','reference'])
   or item-array['method','amount','reference']<>'{}'::jsonb
   or jsonb_typeof(item->'method')<>'string' or jsonb_typeof(item->'amount')<>'string' or jsonb_typeof(item->'reference')<>'string'
  then raise exception 'Invalid payment item' using errcode='22023'; end if;
  method_value=item->>'method';
  if method_value not in ('cash','card','transfer') or method_value=any(seen_methods)
   or (item->>'amount')!~'^[1-9][0-9]{0,11}$' or length(item->>'reference')>200
   or (method_value in ('card','transfer') and btrim(item->>'reference')='')
  then raise exception 'Invalid payment item' using errcode='22023'; end if;
  seen_methods=array_append(seen_methods,method_value);amount_value=(item->>'amount')::numeric(14,0);
  payment_total=payment_total+amount_value;
  if payment_total>=1000000000000 then raise exception 'Invalid payment amount' using errcode='22023'; end if;
 end loop;
 fp=md5(jsonb_build_object('visit_id',p_visit_id,'version',p_expected_version,'payments',p_payments,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'record_payment' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_version or cart_row.status not in ('ready','collecting') or visit_row.status<>'checkout_ready'
 then raise exception 'Cart changed' using errcode='P0001'; end if;
 if cart_row.total_amount<=0 or cart_row.total_amount<>trunc(cart_row.total_amount) then raise exception 'Cart amount must be whole KRW' using errcode='22023'; end if;
 select coalesce(sum(amount),0)+(select coalesce(sum(applied_amount),0) from public.wallet_usage_ledger where cart_id=cart_row.id)
 into already_paid from public.visit_payment_receipts where cart_id=cart_row.id;
 if already_paid+payment_total>cart_row.total_amount then raise exception 'Payment exceeds outstanding amount' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_payments) as elements(value) loop
  method_value=item->>'method';amount_value=(item->>'amount')::numeric(14,0);reference_value=btrim(item->>'reference');
  insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
  values(p_organization_id,'income',amount_value,(now() at time zone 'Asia/Seoul')::date,'Visit payment','','Visit '||p_visit_id::text,false,auth.uid()) returning id into finance_id;
  insert into public.visit_payment_receipts(organization_id,cart_id,visit_id,operation_id,method,amount,reference,created_by,finance_transaction_id)
  values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,method_value,amount_value,reference_value,auth.uid(),finance_id);
 end loop;
 update public.sale_carts set status=case when already_paid+payment_total=total_amount then 'paid' else 'collecting' end,
  version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 if already_paid+payment_total=cart_row.total_amount then
  update public.customer_visits set status='closed',closed_at=now(),version=version+1,updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 end if;
 result=private.visit_payment_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'record_payment',fp,result);
 return result;
end $$;

create or replace function private.fulfill_catalog_sale() returns trigger language plpgsql security definer set search_path='' as $$
declare line public.sale_cart_lines%rowtype; product public.catalog_products%rowtype; wallet_id uuid; money numeric; counts bigint; days integer; starts date; snapshot jsonb;
begin
 if new.status='collecting' and exists(select 1 from public.sale_cart_lines where cart_id=new.id and status='active' and source_type='product') then raise exception 'Product cart requires full payment' using errcode='22023'; end if;
 if new.status<>'paid' or old.status='paid' then return new; end if;
 perform private.assert_sale_cart_manager(new.organization_id);
 if new.organization_id<>old.organization_id or new.customer_id<>old.customer_id or new.visit_id<>old.visit_id or new.total_amount<=0 or
 (select coalesce(sum(amount),0) from public.visit_payment_receipts where cart_id=new.id and organization_id=new.organization_id)+
 (select coalesce(sum(applied_amount),0) from public.wallet_usage_ledger where cart_id=new.id and organization_id=new.organization_id)<>new.total_amount
 then raise exception 'Invalid paid cart receipts or identity' using errcode='P0001'; end if;
 perform p.id from public.catalog_products p where p.organization_id=new.organization_id and p.id in
 (select source_id from public.sale_cart_lines where cart_id=new.id and status='active' and source_type in ('product','membership')) order by p.id for update;
 starts=(now() at time zone 'Asia/Seoul')::date;
 for line in select * from public.sale_cart_lines where cart_id=new.id and status='active' and source_type in ('product','membership') order by source_id,id loop
  select * into product from public.catalog_products where id=line.source_id and organization_id=new.organization_id;
  if not found or product.kind<>line.source_type then raise exception 'Catalog source missing' using errcode='P0001'; end if;
  if line.source_type='product' then
   if exists(select 1 from public.catalog_stock_ledger where sale_line_id=line.id) then continue; end if;
   if product.stock_quantity<line.quantity then raise exception 'Insufficient product stock' using errcode='P0001'; end if;
   update public.catalog_products set stock_quantity=stock_quantity-line.quantity,version=version+1 where id=product.id;
   insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,sale_line_id,created_by) values(new.organization_id,product.id,-line.quantity,'Sale payment completed',line.id,new.updated_by);
  else
   if exists(select 1 from public.customer_wallets where sale_line_id=line.id) then continue; end if;
   snapshot=line.source_snapshot;
   if snapshot->>'id' is distinct from product.id::text or snapshot->>'organization_id' is distinct from new.organization_id::text or snapshot->>'kind' is distinct from 'membership' or coalesce(snapshot->>'benefit_money','')!~'^(0|[1-9][0-9]{0,11})$' or coalesce(snapshot->>'benefit_count','')!~'^(0|[1-9][0-9]{0,5})$' or (snapshot->>'valid_days' is not null and coalesce(snapshot->>'valid_days','')!~'^[1-9][0-9]{0,3}$') then raise exception 'Invalid membership snapshot' using errcode='22023'; end if;
   money=(snapshot->>'benefit_money')::numeric*line.quantity;counts=(snapshot->>'benefit_count')::bigint*line.quantity;days=(snapshot->>'valid_days')::integer;
   if money is null or counts is null or money<0 or money>=1000000000000 or counts<0 or counts>1000000000 or (money=0 and counts=0) or (days is not null and days not between 1 and 3650) then raise exception 'Invalid membership benefit total' using errcode='22023'; end if;
   insert into public.customer_wallets(organization_id,customer_id,product_id,sale_line_id,name_snapshot,money_balance,count_balance,valid_from,expires_on,source_snapshot)
   values(new.organization_id,new.customer_id,product.id,line.id,line.description_snapshot,money,counts,starts,case when days is null then null else starts+days-1 end,snapshot) returning id into wallet_id;
   insert into public.wallet_issuance_ledger(organization_id,wallet_id,sale_line_id,money_amount,count_amount,source_snapshot) values(new.organization_id,wallet_id,line.id,money,counts,snapshot);
  end if;
 end loop;
 return new;
end $$;

revoke all on function public.use_customer_wallet(uuid,uuid,uuid,uuid,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.use_customer_wallet(uuid,uuid,uuid,uuid,text,text,bigint,uuid,boolean) to authenticated;
revoke all on function public.list_customer_wallets(uuid,uuid) from public,anon;
grant execute on function public.list_customer_wallets(uuid,uuid) to authenticated;
commit;
