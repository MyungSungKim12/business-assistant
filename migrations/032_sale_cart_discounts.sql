-- SALE-004: manager-set manual cart discount before the first receipt.
begin;

alter table public.sale_carts
 add column if not exists discount_kind text not null default 'none',
 add column if not exists discount_value numeric(12,0) not null default 0,
 add column if not exists discount_reason text not null default '',
 add column if not exists discount_applied_by uuid references auth.users(id),
 add column if not exists discount_applied_at timestamptz;
alter table public.sale_carts drop constraint if exists sale_carts_discount_rule_check;
alter table public.sale_carts add constraint sale_carts_discount_rule_check check (
 (discount_kind='none' and discount_value=0 and discount_total=0 and discount_reason=''
  and discount_applied_by is null and discount_applied_at is null)
 or (discount_kind='amount' and discount_value>0 and discount_total<subtotal and length(btrim(discount_reason)) between 1 and 1000
  and discount_applied_by is not null and discount_applied_at is not null)
 or (discount_kind='percent' and discount_value between 1 and 99 and discount_total<subtotal and length(btrim(discount_reason)) between 1 and 1000
  and discount_applied_by is not null and discount_applied_at is not null)
);

create table if not exists public.sale_cart_discount_events (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,cart_id uuid not null,
 visit_id uuid not null,operation_id uuid not null,discount_kind text not null check(discount_kind in ('none','amount','percent')),
 discount_value numeric(12,0) not null check(discount_value>=0),discount_total numeric(14,2) not null check(discount_total>=0),
 reason text not null check(length(btrim(reason)) between 1 and 1000),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 unique(organization_id,id),unique(organization_id,operation_id),
 foreign key(organization_id,cart_id,visit_id) references public.sale_carts(organization_id,id,visit_id)
);
create index if not exists sale_cart_discount_events_cart on public.sale_cart_discount_events(organization_id,cart_id,created_at,id);
alter table public.sale_cart_discount_events enable row level security;
drop policy if exists sale_cart_discount_member_select on public.sale_cart_discount_events;
create policy sale_cart_discount_member_select on public.sale_cart_discount_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.sale_cart_discount_events from public,anon,authenticated;
grant select on public.sale_cart_discount_events to authenticated;
drop trigger if exists immutable on public.sale_cart_discount_events;
create trigger immutable before update or delete on public.sale_cart_discount_events
 for each row execute function private.prevent_catalog_ledger_change();

alter table public.visit_product_returns add column if not exists discount_amount numeric(14,0) not null default 0 check(discount_amount>=0);

create or replace function private.sale_cart_line_discount(p_cart_id uuid,p_line_id uuid) returns numeric
 language sql stable security definer set search_path='' as $$
 with lines as (
  select l.id,l.line_total,row_number() over(order by l.created_at,l.id) rn,
   count(*) over() n,c.subtotal,c.discount_total
  from public.sale_cart_lines l join public.sale_carts c on c.id=l.cart_id
  where l.cart_id=p_cart_id and l.status='active'
 ), target as (select * from lines where id=p_line_id), prior as (
  select sum(round(t.discount_total*x.line_total/nullif(t.subtotal,0),0)) allocated
  from target t join lines x on x.rn<t.rn
 )
 select coalesce(case when t.subtotal=0 then 0 when t.rn=t.n
  then t.discount_total-coalesce(p.allocated,0)
  else round(t.discount_total*t.line_total/t.subtotal,0) end,0)
 from target t cross join prior p
$$;
revoke all on function private.sale_cart_line_discount(uuid,uuid) from public,anon,authenticated;

create or replace function private.sale_cart_return_discount(p_cart_id uuid,p_line_id uuid,p_quantity integer) returns numeric
 language sql stable security definer set search_path='' as $$
 with line as (select id,quantity from public.sale_cart_lines where cart_id=p_cart_id and id=p_line_id),
 returned as (select coalesce(sum(quantity),0)::integer qty,coalesce(sum(discount_amount),0) discount
  from public.visit_product_returns where sale_line_id=p_line_id),
 share as (select private.sale_cart_line_discount(p_cart_id,p_line_id) amount)
 select case when l.quantity=r.qty+p_quantity then s.amount-r.discount
  else round(s.amount*(r.qty+p_quantity)/l.quantity,0)-r.discount end
 from line l cross join returned r cross join share s
$$;
revoke all on function private.sale_cart_return_discount(uuid,uuid,integer) from public,anon,authenticated;

create or replace function private.sale_cart_recalculate(p_cart_id uuid) returns void
 language plpgsql security definer set search_path='' as $$
declare total numeric;discount numeric;
begin
 select coalesce(sum(line_total),0) into total from public.sale_cart_lines where cart_id=p_cart_id and status='active';
 if total>=1000000000000 then raise exception 'Cart total exceeds supported amount' using errcode='22023'; end if;
 select case when c.discount_kind='amount' then least(c.discount_value,total)
  when c.discount_kind='percent' then floor(total*c.discount_value/100) else 0 end into discount
 from public.sale_carts c where c.id=p_cart_id;
 if total>0 and discount>=total then raise exception 'Discount exceeds current cart subtotal' using errcode='22023'; end if;
 update public.sale_carts set subtotal=total,discount_total=discount,total_amount=total-discount,
  discount_kind=case when total=0 then 'none' else discount_kind end,
  discount_value=case when total=0 then 0 else discount_value end,
  discount_reason=case when total=0 then '' else discount_reason end,
  discount_applied_by=case when total=0 then null else discount_applied_by end,
  discount_applied_at=case when total=0 then null else discount_applied_at end,
  version=version+1,status='draft',updated_by=auth.uid(),updated_at=now()
 where id=p_cart_id;
 update public.customer_visits v set status='open',version=v.version+1,updated_by=auth.uid(),updated_at=now()
 from public.sale_carts c where c.id=p_cart_id and v.id=c.visit_id and v.status='checkout_ready';
end $$;
revoke all on function private.sale_cart_recalculate(uuid) from public,anon,authenticated;

create or replace function private.sale_cart_payload(p_cart_id uuid) returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object('visit',to_jsonb(v),'cart',to_jsonb(c),
  'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object(
   'returned_quantity',coalesce(r.returned_quantity,0),
   'returned_refund_amount',coalesce(r.returned_refund_amount,0),
   'returned_discount_amount',coalesce(r.returned_discount_amount,0),
   'discount_share',private.sale_cart_line_discount(c.id,l.id)
  ) order by l.created_at,l.id) from public.sale_cart_lines l left join lateral (
   select sum(x.quantity)::integer returned_quantity,sum(x.refund_amount) returned_refund_amount,
    sum(x.discount_amount) returned_discount_amount
   from public.visit_product_returns x where x.organization_id=l.organization_id and x.sale_line_id=l.id
  ) r on true where l.cart_id=c.id),'[]'::jsonb),
  'discount_history',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc)
   from (select id,discount_kind,discount_value,discount_total,reason,created_by,created_at
    from public.sale_cart_discount_events where organization_id=c.organization_id and cart_id=c.id
    order by created_at desc,id desc limit 20) e),'[]'::jsonb)
 ) from public.sale_carts c join public.customer_visits v on v.id=c.visit_id where c.id=p_cart_id
$$;
revoke all on function private.sale_cart_payload(uuid) from public,anon,authenticated;

create or replace function public.apply_sale_cart_discount(
 p_organization_id uuid,p_visit_id uuid,p_kind text,p_value text,p_reason text,
 p_expected_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.sale_cart_operations%rowtype;cart_row public.sale_carts%rowtype;
 value_amount numeric(12,0);discount_amount numeric(14,2);result jsonb;clean_reason text;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_kind not in ('none','amount','percent') or p_value is null or p_value!~'^(0|[1-9][0-9]{0,11})$'
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_confirmed is distinct from true then
  raise exception 'Invalid cart discount' using errcode='22023';end if;
 value_amount=p_value::numeric(12,0);clean_reason=btrim(p_reason);
 if (p_kind='none' and value_amount<>0) or (p_kind='amount' and value_amount=0)
  or (p_kind='percent' and value_amount not between 1 and 99) then
  raise exception 'Invalid discount value' using errcode='22023';end if;
 fp=md5(jsonb_build_object('visit',p_visit_id,'kind',p_kind,'value',p_value,'reason',clean_reason,
  'version',p_expected_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'apply_discount' or prior.request_fingerprint<>fp then
  raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002';end if;
 if cart_row.version<>p_expected_version or cart_row.status not in ('draft','ready') then
  raise exception 'Cart changed or payment has started' using errcode='P0001';end if;
 if exists(select 1 from public.visit_payment_receipts where organization_id=p_organization_id and cart_id=cart_row.id)
  or exists(select 1 from public.wallet_usage_ledger where organization_id=p_organization_id and cart_id=cart_row.id) then
  raise exception 'Discount is frozen after payment starts' using errcode='P0001';end if;
 discount_amount=case when p_kind='amount' then least(value_amount,cart_row.subtotal)
  when p_kind='percent' then floor(cart_row.subtotal*value_amount/100) else 0 end;
 if p_kind<>'none' and (cart_row.subtotal<=0 or discount_amount>=cart_row.subtotal) then
  raise exception 'Discount must leave a positive amount due' using errcode='22023';end if;
 update public.sale_carts set discount_kind=p_kind,discount_value=value_amount,
  discount_reason=case when p_kind='none' then '' else clean_reason end,
  discount_applied_by=case when p_kind='none' then null else auth.uid() end,
  discount_applied_at=case when p_kind='none' then null else now() end,
  discount_total=discount_amount,total_amount=subtotal-discount_amount,status='draft',version=version+1,
  updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 insert into public.sale_cart_discount_events(organization_id,cart_id,visit_id,operation_id,discount_kind,discount_value,discount_total,reason,created_by)
 values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,p_kind,value_amount,discount_amount,clean_reason,auth.uid());
 result=private.sale_cart_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'apply_discount',fp,result);
 return result;
end $$;
revoke all on function public.apply_sale_cart_discount(uuid,uuid,text,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.apply_sale_cart_discount(uuid,uuid,text,text,text,bigint,uuid,boolean) to authenticated;

-- Discounted product returns may refund only the net value allocated to returned units.
create or replace function public.return_visit_product(
 p_organization_id uuid,p_visit_id uuid,p_sale_line_id uuid,p_receipt_id uuid,
 p_quantity integer,p_restock boolean,p_amount text,p_reason text,
 p_expected_cart_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.sale_cart_operations%rowtype;cart_row public.sale_carts%rowtype;visit_row public.customer_visits%rowtype;
 line public.sale_cart_lines%rowtype;receipt public.visit_payment_receipts%rowtype;stock public.catalog_stock_ledger%rowtype;
 wallet public.customer_wallets%rowtype;issuance public.wallet_issuance_ledger%rowtype;amount_value numeric(14,0);
 already_refunded numeric(14,0);gross numeric(14,0);refunded numeric(14,0);net numeric(14,0);returned integer;
 remaining integer;discount_part numeric(14,0);finance_id uuid;result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_sale_line_id is null or p_receipt_id is null or p_operation_id is null
  or p_expected_cart_version is null or p_expected_cart_version<1 or p_quantity is null or p_quantity not between 1 and 999
  or p_restock is null or p_amount is null or p_amount!~'^[1-9][0-9]{0,11}$' or p_reason is null
  or length(btrim(p_reason)) not between 1 and 1000 or p_confirmed is distinct from true then
  raise exception 'Invalid product return request' using errcode='22023';end if;
 amount_value=p_amount::numeric(14,0);
 fp=md5(jsonb_build_object('visit',p_visit_id,'line',p_sale_line_id,'receipt',p_receipt_id,'quantity',p_quantity,
  'restock',p_restock,'amount',p_amount,'reason',btrim(p_reason),'version',p_expected_cart_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'return_product' or prior.request_fingerprint<>fp then
  raise exception 'Operation conflict' using errcode='P0001';end if;return prior.result_snapshot;end if;
 select * into cart_row from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002';end if;
 select * into visit_row from public.customer_visits where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_cart_version or cart_row.status not in ('collecting','paid','void') then
  raise exception 'Cart changed' using errcode='P0001';end if;
 select * into line from public.sale_cart_lines where organization_id=p_organization_id and cart_id=cart_row.id
  and id=p_sale_line_id and status='active' and source_type='product' for update;
 if not found then raise exception 'Product sale line not found' using errcode='P0002';end if;
 select * into stock from public.catalog_stock_ledger where organization_id=p_organization_id and sale_line_id=line.id and movement_kind='sale';
 if not found then raise exception 'Product sale stock movement not found' using errcode='P0002';end if;
 select coalesce(sum(quantity),0) into returned from public.visit_product_returns where organization_id=p_organization_id and sale_line_id=line.id;
 if p_quantity>abs(stock.quantity)-returned then raise exception 'Return quantity exceeds sold quantity' using errcode='22023';end if;
 discount_part=private.sale_cart_return_discount(cart_row.id,line.id,p_quantity);
 if amount_value>line.unit_price*p_quantity-discount_part then raise exception 'Refund exceeds discounted returned item value' using errcode='22023';end if;
 select * into receipt from public.visit_payment_receipts where organization_id=p_organization_id and cart_id=cart_row.id and id=p_receipt_id for update;
 if not found then raise exception 'Receipt not found for this visit' using errcode='P0002';end if;
 select coalesce(sum(amount),0) into already_refunded from public.visit_payment_refunds where receipt_id=receipt.id;
 if already_refunded+amount_value>receipt.amount then raise exception 'Refund exceeds original receipt' using errcode='22023';end if;
 insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
 values(p_organization_id,'expense',amount_value,(now() at time zone 'Asia/Seoul')::date,'Visit refund','','Product return '||p_visit_id::text,false,auth.uid()) returning id into finance_id;
 insert into public.visit_payment_refunds(organization_id,cart_id,visit_id,operation_id,source_kind,receipt_id,amount,reason,finance_transaction_id,created_by)
 values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,'receipt',receipt.id,amount_value,btrim(p_reason),finance_id,auth.uid());
 insert into public.visit_product_returns(organization_id,cart_id,visit_id,sale_line_id,receipt_id,operation_id,quantity,restocked,refund_amount,discount_amount,reason,created_by)
 values(p_organization_id,cart_row.id,p_visit_id,line.id,receipt.id,p_operation_id,p_quantity,p_restock,amount_value,discount_part,btrim(p_reason),auth.uid());
 if p_restock then
  update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1
   where organization_id=p_organization_id and id=stock.product_id and stock_quantity<=1000000000-p_quantity;
  if not found then raise exception 'Invalid stock balance' using errcode='22023';end if;
  insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
  values(p_organization_id,stock.product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid(),'customer_return');
 end if;
 select coalesce((select sum(amount) from public.visit_payment_receipts where cart_id=cart_row.id),0)
  +coalesce((select sum(applied_amount) from public.wallet_usage_ledger where cart_id=cart_row.id),0),coalesce(sum(amount),0)
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
     if wallet.money_balance<>issuance.money_amount or wallet.count_balance<>issuance.count_amount then
      raise exception 'Issued membership has usage and cannot be fully refunded' using errcode='P0001';end if;
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
 values(p_organization_id,p_operation_id,auth.uid(),'return_product',fp,result);return result;
end $$;
revoke all on function public.return_visit_product(uuid,uuid,uuid,uuid,integer,boolean,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.return_visit_product(uuid,uuid,uuid,uuid,integer,boolean,text,text,bigint,uuid,boolean) to authenticated;

commit;
