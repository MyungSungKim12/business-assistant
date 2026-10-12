-- SALE-003: customer product returns, receipt refund and stock movement are atomic.
begin;

create table if not exists public.visit_product_returns (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 cart_id uuid not null,
 visit_id uuid not null,
 sale_line_id uuid not null,
 receipt_id uuid not null references public.visit_payment_receipts(id),
 operation_id uuid not null,
 quantity integer not null check(quantity between 1 and 999),
 restocked boolean not null,
 refund_amount numeric(14,0) not null check(refund_amount>0 and refund_amount<1000000000000),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,operation_id),
 foreign key(organization_id,cart_id,visit_id) references public.sale_carts(organization_id,id,visit_id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id)
);
create index if not exists visit_product_returns_line on public.visit_product_returns(organization_id,sale_line_id,created_at,id);
alter table public.visit_product_returns enable row level security;
drop policy if exists refund_member_select on public.visit_product_returns;
create policy refund_member_select on public.visit_product_returns for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.visit_product_returns from public,anon,authenticated;
grant select on public.visit_product_returns to authenticated;
drop trigger if exists immutable on public.visit_product_returns;
create trigger immutable before update or delete on public.visit_product_returns
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.sale_cart_payload(p_cart_id uuid) returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'visit',to_jsonb(v),'cart',to_jsonb(c),
  'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('returned_quantity',coalesce(r.returned_quantity,0)) order by l.created_at,l.id)
   from public.sale_cart_lines l left join lateral (
    select sum(x.quantity)::integer returned_quantity from public.visit_product_returns x
    where x.organization_id=l.organization_id and x.sale_line_id=l.id
   ) r on true where l.cart_id=c.id),'[]'::jsonb)
 ) from public.sale_carts c join public.customer_visits v on v.id=c.visit_id where c.id=p_cart_id
$$;
revoke all on function private.sale_cart_payload(uuid) from public,anon,authenticated;

alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_movement_check;
alter table public.catalog_stock_ledger add constraint catalog_stock_ledger_movement_check check (
 (movement_kind='receipt' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='sale' and quantity<0 and sale_line_id is not null and operation_id is null)
 or (movement_kind='refund' and quantity>0 and sale_line_id is not null and operation_id is null)
 or (movement_kind='customer_return' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind in ('supplier_return','disposal','stocktake') and quantity<>0 and sale_line_id is null and operation_id is not null)
);

create or replace function private.classify_catalog_sale_movement() returns trigger
 language plpgsql set search_path='' as $$
begin
 if new.sale_line_id is not null then
  if new.quantity<0 then new.movement_kind='sale';
  elsif new.quantity>0 then new.movement_kind='refund';
  else raise exception 'Sale stock movement cannot be zero' using errcode='22023'; end if;
 elsif new.movement_kind is null then new.movement_kind='receipt';
 end if;
 return new;
end $$;
revoke all on function private.classify_catalog_sale_movement() from public,anon,authenticated;

create or replace function public.return_visit_product(
 p_organization_id uuid,p_visit_id uuid,p_sale_line_id uuid,p_receipt_id uuid,
 p_quantity integer,p_restock boolean,p_amount text,p_reason text,
 p_expected_cart_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 fp text; prior public.sale_cart_operations%rowtype; cart_row public.sale_carts%rowtype;
 visit_row public.customer_visits%rowtype; line public.sale_cart_lines%rowtype;
 receipt public.visit_payment_receipts%rowtype; stock public.catalog_stock_ledger%rowtype;
 wallet public.customer_wallets%rowtype; issuance public.wallet_issuance_ledger%rowtype;
 amount_value numeric(14,0); already_refunded numeric(14,0); gross numeric(14,0);
 refunded numeric(14,0); net numeric(14,0); returned integer; remaining integer;
 finance_id uuid; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_sale_line_id is null or p_receipt_id is null or p_operation_id is null
  or p_expected_cart_version is null or p_expected_cart_version<1 or p_quantity is null
  or p_quantity not between 1 and 999 or p_restock is null or p_amount is null
  or p_amount!~'^[1-9][0-9]{0,11}$' or p_reason is null
  or length(btrim(p_reason)) not between 1 and 1000 or p_confirmed is distinct from true then
  raise exception 'Invalid product return request' using errcode='22023';
 end if;
 amount_value=p_amount::numeric(14,0);
 fp=md5(jsonb_build_object('visit',p_visit_id,'line',p_sale_line_id,'receipt',p_receipt_id,
  'quantity',p_quantity,'restock',p_restock,'amount',p_amount,'reason',btrim(p_reason),
  'version',p_expected_cart_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'return_product' or prior.request_fingerprint<>fp then
   raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_cart_version or cart_row.status not in ('collecting','paid','void') then
  raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into line from public.sale_cart_lines where organization_id=p_organization_id and cart_id=cart_row.id
  and id=p_sale_line_id and status='active' and source_type='product' for update;
 if not found then raise exception 'Product sale line not found' using errcode='P0002'; end if;
 select * into stock from public.catalog_stock_ledger where organization_id=p_organization_id and sale_line_id=line.id and movement_kind='sale';
 if not found then raise exception 'Product sale stock movement not found' using errcode='P0002'; end if;
 select coalesce(sum(quantity),0) into returned from public.visit_product_returns where organization_id=p_organization_id and sale_line_id=line.id;
 if p_quantity>abs(stock.quantity)-returned then raise exception 'Return quantity exceeds sold quantity' using errcode='22023'; end if;
 if amount_value>line.unit_price*p_quantity then raise exception 'Refund exceeds returned item value' using errcode='22023'; end if;
 select * into receipt from public.visit_payment_receipts where organization_id=p_organization_id and cart_id=cart_row.id and id=p_receipt_id for update;
 if not found then raise exception 'Receipt not found for this visit' using errcode='P0002'; end if;
 select coalesce(sum(amount),0) into already_refunded from public.visit_payment_refunds where receipt_id=receipt.id;
 if already_refunded+amount_value>receipt.amount then raise exception 'Refund exceeds original receipt' using errcode='22023'; end if;
 insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
 values(p_organization_id,'expense',amount_value,(now() at time zone 'Asia/Seoul')::date,'Visit refund','','Product return '||p_visit_id::text,false,auth.uid()) returning id into finance_id;
 insert into public.visit_payment_refunds(organization_id,cart_id,visit_id,operation_id,source_kind,receipt_id,amount,reason,finance_transaction_id,created_by)
 values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,'receipt',receipt.id,amount_value,btrim(p_reason),finance_id,auth.uid());
 insert into public.visit_product_returns(organization_id,cart_id,visit_id,sale_line_id,receipt_id,operation_id,quantity,restocked,refund_amount,reason,created_by)
 values(p_organization_id,cart_row.id,p_visit_id,line.id,receipt.id,p_operation_id,p_quantity,p_restock,amount_value,btrim(p_reason),auth.uid());
 if p_restock then
  update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1
   where organization_id=p_organization_id and id=stock.product_id and stock_quantity<=1000000000-p_quantity;
  if not found then raise exception 'Invalid stock balance' using errcode='22023'; end if;
  insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
  values(p_organization_id,stock.product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid(),'customer_return');
 end if;
 select coalesce((select sum(amount) from public.visit_payment_receipts where cart_id=cart_row.id),0)
  +coalesce((select sum(applied_amount) from public.wallet_usage_ledger where cart_id=cart_row.id),0),
  coalesce(sum(amount),0) into gross,refunded from public.visit_payment_refunds where cart_id=cart_row.id;
 net=gross-refunded;
 if net<0 then raise exception 'Invalid refund total' using errcode='P0001'; end if;
 if net=0 then
  for line in select * from public.sale_cart_lines where cart_id=cart_row.id and status='active'
   and source_type in ('product','membership') order by source_id,id loop
   if line.source_type='product' then
    select * into stock from public.catalog_stock_ledger where organization_id=p_organization_id and sale_line_id=line.id and movement_kind='sale';
    if found and not exists(select 1 from public.catalog_sale_reversal_ledger where sale_line_id=line.id) then
     select coalesce(sum(quantity),0) into returned from public.visit_product_returns where organization_id=p_organization_id and sale_line_id=line.id;
     remaining=abs(stock.quantity)-returned;
     if remaining>0 then
      update public.catalog_products set stock_quantity=stock_quantity+remaining,version=version+1 where organization_id=p_organization_id and id=stock.product_id;
      insert into public.catalog_sale_reversal_ledger(organization_id,cart_id,sale_line_id,kind,product_id,stock_quantity,refund_operation_id,created_by)
       values(p_organization_id,cart_row.id,line.id,'product',stock.product_id,remaining,p_operation_id,auth.uid());
     end if;
    end if;
   else
    select * into wallet from public.customer_wallets where organization_id=p_organization_id and sale_line_id=line.id for update;
    if found and not exists(select 1 from public.catalog_sale_reversal_ledger where sale_line_id=line.id) then
     select * into issuance from public.wallet_issuance_ledger where wallet_id=wallet.id;
     if wallet.money_balance<>issuance.money_amount or wallet.count_balance<>issuance.count_amount then raise exception 'Issued membership has usage and cannot be fully refunded' using errcode='P0001'; end if;
     update public.customer_wallets set money_balance=0,count_balance=0 where id=wallet.id;
     insert into public.catalog_sale_reversal_ledger(organization_id,cart_id,sale_line_id,kind,wallet_id,money_amount,count_amount,refund_operation_id,created_by)
      values(p_organization_id,cart_row.id,line.id,'membership',wallet.id,issuance.money_amount,issuance.count_amount,p_operation_id,auth.uid());
    end if;
   end if;
  end loop;
 end if;
 update public.sale_carts set status='void',version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 update public.customer_visits set status='canceled',closed_at=coalesce(closed_at,now()),version=version+1,updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 result=private.visit_payment_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'return_product',fp,result);
 return result;
end $$;
revoke all on function public.return_visit_product(uuid,uuid,uuid,uuid,integer,boolean,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.return_visit_product(uuid,uuid,uuid,uuid,integer,boolean,text,text,bigint,uuid,boolean) to authenticated;

-- Keep later receipt refunds from re-stocking units already returned through the new flow.
create or replace function public.refund_visit_payment(
 p_organization_id uuid,p_visit_id uuid,p_source_id uuid,p_amount text,p_reason text,
 p_expected_cart_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.sale_cart_operations%rowtype;cart_row public.sale_carts%rowtype;visit_row public.customer_visits%rowtype;
 receipt public.visit_payment_receipts%rowtype;usage public.wallet_usage_ledger%rowtype;wallet public.customer_wallets%rowtype;
 issuance public.wallet_issuance_ledger%rowtype;line public.sale_cart_lines%rowtype;stock public.catalog_stock_ledger%rowtype;
 amount_value numeric(14,0);already numeric(14,0);gross numeric(14,0);refunded numeric(14,0);net numeric(14,0);finance_id uuid;result jsonb;
 returned integer;remaining integer;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_source_id is null or p_operation_id is null or p_expected_cart_version is null or p_expected_cart_version<1
  or p_amount is null or p_amount!~'^[1-9][0-9]{0,11}$' or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_confirmed is distinct from true
 then raise exception 'Invalid refund request' using errcode='22023';end if;
 amount_value=p_amount::numeric(14,0);fp=md5(jsonb_build_object('visit',p_visit_id,'source',p_source_id,'amount',p_amount,'reason',btrim(p_reason),'version',p_expected_cart_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'refund_payment' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002';end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_cart_version or cart_row.status not in ('collecting','paid','void') then raise exception 'Cart changed' using errcode='P0001';end if;
 select * into receipt from public.visit_payment_receipts where organization_id=p_organization_id and cart_id=cart_row.id and id=p_source_id for update;
 if found then
  select coalesce(sum(amount),0) into already from public.visit_payment_refunds where receipt_id=receipt.id;
  if already+amount_value>receipt.amount then raise exception 'Refund exceeds original receipt' using errcode='22023';end if;
  insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
  values(p_organization_id,'expense',amount_value,(now() at time zone 'Asia/Seoul')::date,'Visit refund','','Refund visit '||p_visit_id::text,false,auth.uid()) returning id into finance_id;
  insert into public.visit_payment_refunds(organization_id,cart_id,visit_id,operation_id,source_kind,receipt_id,amount,reason,finance_transaction_id,created_by)
  values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,'receipt',receipt.id,amount_value,btrim(p_reason),finance_id,auth.uid());
 else
  select * into usage from public.wallet_usage_ledger where organization_id=p_organization_id and cart_id=cart_row.id and id=p_source_id for update;
  if not found then raise exception 'Refund source not found' using errcode='P0002';end if;
  if amount_value<>usage.applied_amount or exists(select 1 from public.visit_payment_refunds where wallet_usage_id=usage.id) then raise exception 'Wallet usage must be fully reversed once' using errcode='22023';end if;
  select * into wallet from public.customer_wallets where organization_id=p_organization_id and id=usage.wallet_id for update;
  update public.customer_wallets set money_balance=money_balance-usage.money_delta,count_balance=count_balance-usage.count_delta where id=wallet.id;
  insert into public.visit_payment_refunds(organization_id,cart_id,visit_id,operation_id,source_kind,wallet_usage_id,amount,reason,money_delta,count_delta,created_by)
  values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,'wallet_usage',usage.id,amount_value,btrim(p_reason),-usage.money_delta,-usage.count_delta,auth.uid());
 end if;
 select coalesce((select sum(amount) from public.visit_payment_receipts where cart_id=cart_row.id),0)+coalesce((select sum(applied_amount) from public.wallet_usage_ledger where cart_id=cart_row.id),0),coalesce(sum(amount),0)
 into gross,refunded from public.visit_payment_refunds where cart_id=cart_row.id;net=gross-refunded;
 if net<0 then raise exception 'Invalid refund total' using errcode='P0001';end if;
 if net=0 then
  for line in select * from public.sale_cart_lines where cart_id=cart_row.id and status='active' and source_type in ('product','membership') order by source_id,id loop
   if line.source_type='product' then
    select * into stock from public.catalog_stock_ledger where organization_id=p_organization_id and sale_line_id=line.id and movement_kind='sale';
    if found and not exists(select 1 from public.catalog_sale_reversal_ledger where sale_line_id=line.id) then
     select coalesce(sum(quantity),0) into returned from public.visit_product_returns where organization_id=p_organization_id and sale_line_id=line.id;
     remaining=abs(stock.quantity)-returned;
     if remaining>0 then
      update public.catalog_products set stock_quantity=stock_quantity+remaining,version=version+1 where organization_id=p_organization_id and id=stock.product_id;
      insert into public.catalog_sale_reversal_ledger(organization_id,cart_id,sale_line_id,kind,product_id,stock_quantity,refund_operation_id,created_by)
      values(p_organization_id,cart_row.id,line.id,'product',stock.product_id,remaining,p_operation_id,auth.uid());
     end if;
    end if;
   else
    select * into wallet from public.customer_wallets where organization_id=p_organization_id and sale_line_id=line.id for update;
    if found and not exists(select 1 from public.catalog_sale_reversal_ledger where sale_line_id=line.id) then
     select * into issuance from public.wallet_issuance_ledger where wallet_id=wallet.id;
     if wallet.money_balance<>issuance.money_amount or wallet.count_balance<>issuance.count_amount then raise exception 'Issued membership has usage and cannot be fully refunded' using errcode='P0001';end if;
     update public.customer_wallets set money_balance=0,count_balance=0 where id=wallet.id;
     insert into public.catalog_sale_reversal_ledger(organization_id,cart_id,sale_line_id,kind,wallet_id,money_amount,count_amount,refund_operation_id,created_by)
     values(p_organization_id,cart_row.id,line.id,'membership',wallet.id,issuance.money_amount,issuance.count_amount,p_operation_id,auth.uid());
    end if;
   end if;
  end loop;
 end if;
 update public.sale_carts set status='void',version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 update public.customer_visits set status='canceled',closed_at=coalesce(closed_at,now()),version=version+1,updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 result=private.visit_payment_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot) values(p_organization_id,p_operation_id,auth.uid(),'refund_payment',fp,result);return result;
end $$;
revoke all on function public.refund_visit_payment(uuid,uuid,uuid,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.refund_visit_payment(uuid,uuid,uuid,text,text,bigint,uuid,boolean) to authenticated;

commit;
