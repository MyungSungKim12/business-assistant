-- SALE-003/WAL-003: immutable refunds, wallet-use reversal, full-sale reversal.
begin;

create table if not exists public.visit_payment_refunds (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,cart_id uuid not null,visit_id uuid not null,
 operation_id uuid not null,source_kind text not null check(source_kind in ('receipt','wallet_usage')),
 receipt_id uuid references public.visit_payment_receipts(id),wallet_usage_id uuid references public.wallet_usage_ledger(id),
 amount numeric(14,0) not null check(amount>0 and amount<1000000000000),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 money_delta numeric(12,0) not null default 0 check(money_delta>=0 and money_delta<1000000000000),
 count_delta integer not null default 0 check(count_delta in (0,1)),
 finance_transaction_id uuid unique references public.finance_transactions(id),created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),unique(organization_id,id),unique(organization_id,operation_id),
 foreign key(organization_id,cart_id,visit_id) references public.sale_carts(organization_id,id,visit_id),
 check((source_kind='receipt' and receipt_id is not null and wallet_usage_id is null and money_delta=0 and count_delta=0 and finance_transaction_id is not null)
    or (source_kind='wallet_usage' and receipt_id is null and wallet_usage_id is not null and finance_transaction_id is null))
);
create unique index if not exists visit_payment_refunds_wallet_once on public.visit_payment_refunds(wallet_usage_id) where wallet_usage_id is not null;
create index if not exists visit_payment_refunds_cart_time on public.visit_payment_refunds(organization_id,cart_id,created_at,id);

create table if not exists public.catalog_sale_reversal_ledger (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,cart_id uuid not null,sale_line_id uuid not null,
 kind text not null check(kind in ('product','membership')),product_id uuid,wallet_id uuid,
 stock_quantity integer not null default 0 check(stock_quantity>=0),money_amount numeric(12,0) not null default 0 check(money_amount>=0),
 count_amount integer not null default 0 check(count_amount>=0),refund_operation_id uuid not null,created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),unique(organization_id,sale_line_id),
 foreign key(organization_id,cart_id) references public.sale_carts(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id),
 foreign key(organization_id,product_id) references public.catalog_products(organization_id,id),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 check((kind='product' and product_id is not null and wallet_id is null and stock_quantity>0 and money_amount=0 and count_amount=0)
    or (kind='membership' and product_id is null and wallet_id is not null and stock_quantity=0 and (money_amount>0 or count_amount>0)))
);

do $$ declare t text; begin foreach t in array array['visit_payment_refunds','catalog_sale_reversal_ledger'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('drop policy if exists refund_member_select on public.%I',t);
 execute format('create policy refund_member_select on public.%I for select to authenticated using ((select private.has_organization_role(organization_id,array[''owner'',''admin'',''member'']::text[])))',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
end loop;end $$;
drop trigger if exists immutable on public.visit_payment_refunds;
create trigger immutable before update or delete on public.visit_payment_refunds for each row execute function private.prevent_catalog_ledger_change();
drop trigger if exists immutable on public.catalog_sale_reversal_ledger;
create trigger immutable before update or delete on public.catalog_sale_reversal_ledger for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.prevent_linked_finance_change() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.visit_payment_receipts where finance_transaction_id=old.id)
  or exists(select 1 from public.visit_payment_refunds where finance_transaction_id=old.id)
 then raise exception 'Visit payment finance transaction is immutable' using errcode='P0001'; end if;
 return case when tg_op='DELETE' then old else new end;
end $$;

create or replace function private.visit_payment_payload(p_cart_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'visit_id',c.visit_id,'cart_id',c.id,'cart_version',c.version,'total_amount',c.total_amount,
  'paid_amount',coalesce(g.gross,0)-coalesce(f.refunded,0),
  'outstanding_amount',greatest(c.total_amount-(coalesce(g.gross,0)-coalesce(f.refunded,0)),0),
  'refunded_amount',coalesce(f.refunded,0),'currency','KRW','status',c.status,
  'receipts',coalesce(g.receipts,'[]'::jsonb),'refunds',coalesce(f.refunds,'[]'::jsonb)
 ) from public.sale_carts c
 left join lateral (
  select sum(x.amount) gross,jsonb_agg(jsonb_build_object('id',x.id,'method',x.method,'amount',x.amount,'reference',x.reference,'received_at',x.received_at,'operation_id',x.operation_id) order by x.received_at,x.id) receipts
  from (select r.id,r.method,r.amount,r.reference,r.received_at,r.operation_id from public.visit_payment_receipts r where r.cart_id=c.id
   union all select u.id,'wallet'::text,u.applied_amount,w.name_snapshot||case when u.mode='count' then ' · 1회' else ' · 금액' end,u.created_at,u.operation_id from public.wallet_usage_ledger u join public.customer_wallets w on w.id=u.wallet_id where u.cart_id=c.id) x
 ) g on true
 left join lateral (
  select sum(r.amount) refunded,jsonb_agg(jsonb_build_object('id',r.id,'source_id',coalesce(r.receipt_id,r.wallet_usage_id),'source_kind',r.source_kind,'amount',r.amount,'reason',r.reason,'created_at',r.created_at,'operation_id',r.operation_id) order by r.created_at,r.id) refunds
  from public.visit_payment_refunds r where r.cart_id=c.id
 ) f on true where c.id=p_cart_id
$$;

create or replace function public.refund_visit_payment(
 p_organization_id uuid,p_visit_id uuid,p_source_id uuid,p_amount text,p_reason text,
 p_expected_cart_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text;prior public.sale_cart_operations%rowtype;cart_row public.sale_carts%rowtype;visit_row public.customer_visits%rowtype;
 receipt public.visit_payment_receipts%rowtype;usage public.wallet_usage_ledger%rowtype;wallet public.customer_wallets%rowtype;
 issuance public.wallet_issuance_ledger%rowtype;line public.sale_cart_lines%rowtype;stock public.catalog_stock_ledger%rowtype;
 amount_value numeric(14,0);already numeric(14,0);gross numeric(14,0);refunded numeric(14,0);net numeric(14,0);finance_id uuid;result jsonb;
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
    select * into stock from public.catalog_stock_ledger where sale_line_id=line.id and quantity<0;
    if found and not exists(select 1 from public.catalog_sale_reversal_ledger where sale_line_id=line.id) then
     update public.catalog_products set stock_quantity=stock_quantity-stock.quantity,version=version+1 where organization_id=p_organization_id and id=stock.product_id;
     insert into public.catalog_sale_reversal_ledger(organization_id,cart_id,sale_line_id,kind,product_id,stock_quantity,refund_operation_id,created_by)
     values(p_organization_id,cart_row.id,line.id,'product',stock.product_id,-stock.quantity,p_operation_id,auth.uid());
    end if;
   else
    select * into wallet from public.customer_wallets where sale_line_id=line.id for update;
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
