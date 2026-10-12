-- INV-001/002, WAL-001/004, SALE-001. Apply after 026; safe to reapply.
begin;
create table if not exists public.catalog_products (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 sku text not null check(length(btrim(sku)) between 1 and 80), name text not null check(length(btrim(name)) between 1 and 200),
 kind text not null check(kind in ('product','membership')), unit_name text not null check(length(btrim(unit_name)) between 1 and 30),
 sale_price numeric(12,0) not null check(sale_price>0 and sale_price<1000000000000),
 benefit_money numeric(12,0) not null default 0 check(benefit_money>=0 and benefit_money<1000000000000),
 benefit_count integer not null default 0 check(benefit_count between 0 and 999999),
 valid_days integer check(valid_days between 1 and 3650), is_active boolean not null default true,
 version bigint not null default 1 check(version>0), stock_quantity integer not null default 0 check(stock_quantity between 0 and 1000000000),
 unique(organization_id,id), unique(organization_id,sku),
 check((kind='product' and benefit_money=0 and benefit_count=0 and valid_days is null) or
       (kind='membership' and (benefit_money>0 or benefit_count>0) and stock_quantity=0))
);
create table if not exists public.catalog_stock_ledger (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, product_id uuid not null,
 quantity integer not null check(quantity<>0), reason text not null check(length(btrim(reason)) between 1 and 1000),
 sale_line_id uuid unique, operation_id uuid, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(organization_id,product_id) references public.catalog_products(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id),
 unique(organization_id,operation_id), check((quantity>0 and operation_id is not null and sale_line_id is null) or (quantity<0 and sale_line_id is not null and operation_id is null))
);
create index if not exists catalog_stock_ledger_product on public.catalog_stock_ledger(organization_id,product_id,created_at);
create table if not exists public.customer_wallets (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, customer_id uuid not null references public.customers(id),
 product_id uuid not null, sale_line_id uuid not null unique, name_snapshot text not null,
 money_balance numeric(12,0) not null check(money_balance>=0 and money_balance<1000000000000),
 count_balance integer not null check(count_balance between 0 and 1000000000),
 valid_from date not null, expires_on date, source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,product_id) references public.catalog_products(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id),
 check(expires_on is null or expires_on>=valid_from)
);
create index if not exists customer_wallets_customer on public.customer_wallets(organization_id,customer_id,created_at);
create table if not exists public.wallet_issuance_ledger (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, wallet_id uuid not null unique,
 sale_line_id uuid not null unique, money_amount numeric(12,0) not null check(money_amount>=0 and money_amount<1000000000000),
 count_amount integer not null check(count_amount between 0 and 1000000000), source_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id)
);
do $$ declare t text; begin
 foreach t in array array['catalog_products','catalog_stock_ledger','customer_wallets','wallet_issuance_ledger'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists catalog_member_select on public.%I',t);
  execute format('create policy catalog_member_select on public.%I for select to authenticated using ((select private.has_organization_role(organization_id,array[''owner'',''admin'',''member'']::text[])))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create or replace function private.prevent_catalog_ledger_change() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Catalog ledger is immutable' using errcode='P0001'; end $$;
revoke all on function private.prevent_catalog_ledger_change() from public,anon,authenticated;
drop trigger if exists immutable on public.catalog_stock_ledger;
create trigger immutable before update or delete on public.catalog_stock_ledger for each row execute function private.prevent_catalog_ledger_change();
drop trigger if exists immutable on public.wallet_issuance_ledger;
create trigger immutable before update or delete on public.wallet_issuance_ledger for each row execute function private.prevent_catalog_ledger_change();

drop index if exists public.sale_cart_lines_active_source;
create unique index sale_cart_lines_active_source on public.sale_cart_lines(organization_id,source_type,source_id) where status='active' and source_type='treatment_draft';
create unique index if not exists sale_cart_lines_active_catalog on public.sale_cart_lines(organization_id,cart_id,source_id) where status='active' and source_type in ('product','membership');

create or replace function private.catalog_payload(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p)||jsonb_build_object('sale_price',p.sale_price::text,'benefit_money',p.benefit_money::text) from public.catalog_products p where id=p_id
$$;
revoke all on function private.catalog_payload(uuid) from public,anon,authenticated;
create or replace function public.list_catalog_products(p_organization_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']) then raise exception 'Catalog read permission required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(private.catalog_payload(id) order by name,id) from public.catalog_products where organization_id=p_organization_id),'[]'::jsonb);
end $$;

create or replace function public.save_catalog_product(p_organization_id uuid,p_product_id uuid,p_expected_version bigint,p_operation_id uuid,p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb; v jsonb; product_id uuid;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_operation_id is null or p_values is null or jsonb_typeof(p_values)<>'object' or p_values='{}'::jsonb or
 p_values-array['sku','name','kind','unit_name','sale_price','benefit_money','benefit_count','valid_days','is_active']<>'{}'::jsonb or
 (p_product_id is null and p_expected_version is not null) or (p_product_id is not null and (p_expected_version is null or p_expected_version<1))
 then raise exception 'Invalid catalog request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('product',p_product_id,'version',p_expected_version,'values',p_values)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'save_catalog' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 if p_product_id is not null then
  select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
  if not found then raise exception 'Product not found' using errcode='P0002'; end if;
  if product.version<>p_expected_version then raise exception 'Product changed' using errcode='P0001'; end if;
  v=private.catalog_payload(product.id)||p_values;
 else v=jsonb_build_object('benefit_money','0','benefit_count',0,'valid_days',null,'is_active',true,'unit_name','개')||p_values; end if;
 if not(v ?& array['sku','name','kind','unit_name','sale_price']) or
 jsonb_typeof(v->'sku') is distinct from 'string' or length(btrim(v->>'sku')) not between 1 and 80 or
 jsonb_typeof(v->'name') is distinct from 'string' or length(btrim(v->>'name')) not between 1 and 200 or
 jsonb_typeof(v->'unit_name') is distinct from 'string' or length(btrim(v->>'unit_name')) not between 1 and 30 or
 jsonb_typeof(v->'kind') is distinct from 'string' or v->>'kind' not in ('product','membership') or
 jsonb_typeof(v->'sale_price') is distinct from 'string' or (v->>'sale_price')!~'^[1-9][0-9]{0,11}$' or
 jsonb_typeof(v->'benefit_money') is distinct from 'string' or (v->>'benefit_money')!~'^(0|[1-9][0-9]{0,11})$' or
 jsonb_typeof(v->'benefit_count') is distinct from 'number' or (v->>'benefit_count')!~'^(0|[1-9][0-9]{0,5})$' or
 jsonb_typeof(v->'is_active') is distinct from 'boolean' or
 (jsonb_typeof(v->'valid_days') is distinct from 'null' and (jsonb_typeof(v->'valid_days') is distinct from 'number' or (v->>'valid_days')!~'^[1-9][0-9]{0,3}$'))
 then raise exception 'Invalid catalog values' using errcode='22023'; end if;
 if ((v->>'valid_days')::integer is not null and (v->>'valid_days')::integer not between 1 and 3650) or
 (v->>'kind'='product' and ((v->>'benefit_money')::numeric<>0 or (v->>'benefit_count')::integer<>0 or v->>'valid_days' is not null)) or
 (v->>'kind'='membership' and (v->>'benefit_money')::numeric=0 and (v->>'benefit_count')::integer=0) or
 (p_product_id is not null and product.kind<>v->>'kind') then raise exception 'Invalid catalog benefits or kind' using errcode='22023'; end if;
 if p_product_id is null then
 insert into public.catalog_products(organization_id,sku,name,kind,unit_name,sale_price,benefit_money,benefit_count,valid_days,is_active)
 values(p_organization_id,btrim(v->>'sku'),btrim(v->>'name'),v->>'kind',btrim(v->>'unit_name'),(v->>'sale_price')::numeric,(v->>'benefit_money')::numeric,(v->>'benefit_count')::integer,(v->>'valid_days')::integer,(v->>'is_active')::boolean) returning id into product_id;
 else
 update public.catalog_products set sku=btrim(v->>'sku'),name=btrim(v->>'name'),unit_name=btrim(v->>'unit_name'),sale_price=(v->>'sale_price')::numeric,benefit_money=(v->>'benefit_money')::numeric,benefit_count=(v->>'benefit_count')::integer,valid_days=(v->>'valid_days')::integer,is_active=(v->>'is_active')::boolean,version=version+1 where id=p_product_id returning id into product_id;
 end if;
 result=private.catalog_payload(product_id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'save_catalog',fp,result,now()); return result;
end $$;

create or replace function public.receive_catalog_stock(p_organization_id uuid,p_product_id uuid,p_quantity integer,p_reason text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_quantity is null or p_quantity not between 1 and 999999 or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Invalid stock receipt' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',p_reason)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'receive_stock' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.kind<>'product' or product.stock_quantity::bigint+p_quantity>1000000000 then raise exception 'Invalid stock balance' using errcode='22023'; end if;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where id=p_product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by) values(p_organization_id,p_product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid());
 result=private.catalog_payload(p_product_id); insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'receive_stock',fp,result,now()); return result;
end $$;

create or replace function public.add_catalog_product_to_cart(p_organization_id uuid,p_visit_id uuid,p_product_id uuid,p_expected_version bigint,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; cart public.sale_carts%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_product_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'Invalid cart request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('visit',p_visit_id,'product',p_product_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'add_catalog' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into cart from public.sale_carts where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 if cart.version<>p_expected_version or cart.status not in ('draft','ready') then raise exception 'Cart changed' using errcode='P0001'; end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for share;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if not product.is_active then raise exception 'Product is stopped' using errcode='P0001'; end if;
 insert into public.sale_cart_lines(organization_id,cart_id,source_type,source_id,description_snapshot,quantity,unit_price,line_total,source_snapshot,created_by)
 values(p_organization_id,cart.id,product.kind,product.id,product.name,1,product.sale_price,product.sale_price,private.catalog_payload(product.id),auth.uid());
 perform private.sale_cart_recalculate(cart.id); result=private.sale_cart_payload(cart.id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'add_catalog',fp,result,now()); return result;
exception when unique_violation then raise exception 'Product already active in this cart' using errcode='P0001';
end $$;

create or replace function public.list_customer_wallets(p_organization_id uuid,p_customer_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']) then raise exception 'Wallet read permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.customers where organization_id=p_organization_id and id=p_customer_id) then raise exception 'Customer not found' using errcode='P0002'; end if;
 return coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('money_balance',w.money_balance::text) order by w.created_at,w.id) from public.customer_wallets w where organization_id=p_organization_id and customer_id=p_customer_id),'[]'::jsonb);
end $$;

create or replace function private.fulfill_catalog_sale() returns trigger language plpgsql security definer set search_path='' as $$
declare line public.sale_cart_lines%rowtype; product public.catalog_products%rowtype; wallet_id uuid; money numeric; counts bigint; days integer; starts date; snapshot jsonb;
begin
 if new.status='collecting' and exists(select 1 from public.sale_cart_lines where cart_id=new.id and status='active' and source_type='product') then raise exception 'Product cart requires full payment' using errcode='22023'; end if;
 if new.status<>'paid' or old.status='paid' then return new; end if;
 perform private.assert_sale_cart_manager(new.organization_id);
 if new.organization_id<>old.organization_id or new.customer_id<>old.customer_id or new.visit_id<>old.visit_id or new.total_amount<=0 or
 (select coalesce(sum(amount),0) from public.visit_payment_receipts where cart_id=new.id and organization_id=new.organization_id)<>new.total_amount
 then raise exception 'Invalid paid cart receipts or identity' using errcode='P0001'; end if;
 -- All products are locked in UUID order before any stock change: overlapping carts cannot deadlock.
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
    if snapshot->>'id' is distinct from product.id::text or snapshot->>'organization_id' is distinct from new.organization_id::text or snapshot->>'kind' is distinct from 'membership' or
     coalesce(snapshot->>'benefit_money','')!~'^(0|[1-9][0-9]{0,11})$' or
     coalesce(snapshot->>'benefit_count','')!~'^(0|[1-9][0-9]{0,5})$' or
     (snapshot->>'valid_days' is not null and coalesce(snapshot->>'valid_days','')!~'^[1-9][0-9]{0,3}$')
    then raise exception 'Invalid membership snapshot' using errcode='22023'; end if;
   money=(snapshot->>'benefit_money')::numeric*line.quantity; counts=(snapshot->>'benefit_count')::bigint*line.quantity; days=(snapshot->>'valid_days')::integer;
   if money is null or counts is null or money<0 or money>=1000000000000 or counts<0 or counts>1000000000 or (money=0 and counts=0) or (days is not null and days not between 1 and 3650) then raise exception 'Invalid membership benefit total' using errcode='22023'; end if;
   insert into public.customer_wallets(organization_id,customer_id,product_id,sale_line_id,name_snapshot,money_balance,count_balance,valid_from,expires_on,source_snapshot)
   values(new.organization_id,new.customer_id,product.id,line.id,line.description_snapshot,money,counts,starts,case when days is null then null else starts+days-1 end,snapshot) returning id into wallet_id;
   insert into public.wallet_issuance_ledger(organization_id,wallet_id,sale_line_id,money_amount,count_amount,source_snapshot) values(new.organization_id,wallet_id,line.id,money,counts,snapshot);
  end if;
 end loop;
 return new;
end $$;
revoke all on function private.fulfill_catalog_sale() from public,anon,authenticated;
drop trigger if exists sale_cart_catalog_fulfillment on public.sale_carts;
create trigger sale_cart_catalog_fulfillment before update of status on public.sale_carts for each row execute function private.fulfill_catalog_sale();
revoke all on function public.list_catalog_products(uuid),public.save_catalog_product(uuid,uuid,bigint,uuid,jsonb),public.receive_catalog_stock(uuid,uuid,integer,text,uuid),public.add_catalog_product_to_cart(uuid,uuid,uuid,bigint,uuid),public.list_customer_wallets(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_catalog_products(uuid),public.save_catalog_product(uuid,uuid,bigint,uuid,jsonb),public.receive_catalog_stock(uuid,uuid,integer,text,uuid),public.add_catalog_product_to_cart(uuid,uuid,uuid,bigint,uuid),public.list_customer_wallets(uuid,uuid) to authenticated;
commit;
