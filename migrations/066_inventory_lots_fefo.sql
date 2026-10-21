-- INV-003: lot-aware stock with expiry-first consumption. Apply after 065.
begin;

alter table public.catalog_stock_ledger
 add column if not exists expires_on date;
create unique index if not exists catalog_stock_ledger_org_id on public.catalog_stock_ledger(organization_id,id);

create table if not exists public.catalog_inventory_lots (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 product_id uuid not null,
 lot_code text not null default '',
 received_quantity integer not null check(received_quantity between 1 and 1000000000),
 remaining_quantity integer not null check(remaining_quantity between 0 and received_quantity),
 expires_on date,
 received_at timestamptz not null default now(),
 created_by uuid references auth.users(id),
 source_movement_id uuid unique,
 created_at timestamptz not null default now(),
 unique(organization_id,id),
 foreign key(organization_id,product_id) references public.catalog_products(organization_id,id) on delete restrict,
 check(length(lot_code)<=120)
);
create index if not exists catalog_inventory_lots_fefo
 on public.catalog_inventory_lots(organization_id,product_id,expires_on,received_at,id)
 where remaining_quantity>0;
create unique index if not exists catalog_inventory_lots_legacy_once
 on public.catalog_inventory_lots(organization_id,product_id)
 where lot_code='기존 재고' and source_movement_id is null;
create table if not exists public.catalog_stock_lot_allocations (
 organization_id uuid not null,
 movement_id uuid not null,
 lot_id uuid not null,
 quantity integer not null check(quantity>0),
 created_at timestamptz not null default now(),
 primary key(organization_id,movement_id,lot_id),
 foreign key(organization_id,movement_id) references public.catalog_stock_ledger(organization_id,id) on delete restrict,
 foreign key(organization_id,lot_id) references public.catalog_inventory_lots(organization_id,id) on delete restrict
);
alter table public.catalog_inventory_lots enable row level security;
alter table public.catalog_stock_lot_allocations enable row level security;
drop policy if exists catalog_inventory_lots_member_select on public.catalog_inventory_lots;
create policy catalog_inventory_lots_member_select on public.catalog_inventory_lots for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists catalog_stock_lot_allocations_member_select on public.catalog_stock_lot_allocations;
create policy catalog_stock_lot_allocations_member_select on public.catalog_stock_lot_allocations for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.catalog_inventory_lots,public.catalog_stock_lot_allocations from public,anon,authenticated;
grant select on public.catalog_inventory_lots,public.catalog_stock_lot_allocations to authenticated;

-- Preserve pre-lot stock exactly once as an undated opening lot. New movements are lot-tracked below.
create table if not exists private.catalog_migration_markers(key text primary key,applied_at timestamptz not null default now());
do $$ begin
 if not exists(select 1 from private.catalog_migration_markers where key='066_opening_lots') then
  insert into public.catalog_inventory_lots(organization_id,product_id,lot_code,received_quantity,remaining_quantity,received_at,created_by)
   select organization_id,id,'기존 재고',stock_quantity,stock_quantity,now(),null
   from public.catalog_products where kind='product' and stock_quantity>0
   on conflict do nothing;
  insert into private.catalog_migration_markers(key) values('066_opening_lots');
 end if;
end $$;

create or replace function private.track_catalog_stock_lot() returns trigger
 language plpgsql security definer set search_path='' as $$
declare remaining integer; lot public.catalog_inventory_lots%rowtype; take integer;
begin
 if new.quantity>0 then
  insert into public.catalog_inventory_lots(organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,received_at,created_by,source_movement_id)
  values(new.organization_id,new.product_id,coalesce(nullif(btrim(new.lot_code),''),''),new.quantity,new.quantity,new.expires_on,new.created_at,new.created_by,new.id)
  on conflict (source_movement_id) do nothing;
  return null;
 end if;

 remaining=-new.quantity;
 for lot in
  select * from public.catalog_inventory_lots
  where organization_id=new.organization_id and product_id=new.product_id and remaining_quantity>0
   and (expires_on is null or expires_on>=current_date)
  order by expires_on asc nulls last,received_at asc,id asc for update
 loop
  take=least(remaining,lot.remaining_quantity);
  update public.catalog_inventory_lots set remaining_quantity=remaining_quantity-take where organization_id=lot.organization_id and id=lot.id;
  insert into public.catalog_stock_lot_allocations(organization_id,movement_id,lot_id,quantity)
   values(new.organization_id,new.id,lot.id,take);
  remaining=remaining-take;
  exit when remaining=0;
 end loop;
 if remaining>0 then raise exception 'Insufficient unexpired lot stock' using errcode='P0001'; end if;
 return null;
end $$;
revoke all on function private.track_catalog_stock_lot() from public,anon,authenticated;
drop trigger if exists catalog_stock_lot_tracking on public.catalog_stock_ledger;
create trigger catalog_stock_lot_tracking after insert on public.catalog_stock_ledger
 for each row execute function private.track_catalog_stock_lot();

drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid);
create or replace function public.receive_catalog_stock(
 p_organization_id uuid,p_product_id uuid,p_quantity integer,p_reason text,p_operation_id uuid,
 p_expires_on date default null,p_lot_code text default ''
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_quantity is null or p_quantity not between 1 and 999999 or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or length(coalesce(p_lot_code,''))>120 then raise exception 'Invalid stock receipt' using errcode='22023'; end if;
 if p_expires_on is null and btrim(coalesce(p_lot_code,''))='' then
  -- Keep persisted retry requests from the pre-066 desktop build replayable.
  fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',p_reason)::text);
 else
  fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',btrim(p_reason),'expires_on',p_expires_on,'lot_code',btrim(coalesce(p_lot_code,'')))::text);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'receive_stock' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.kind<>'product' or product.stock_quantity::bigint+p_quantity>1000000000 then raise exception 'Invalid stock balance' using errcode='22023'; end if;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where id=p_product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,expires_on,lot_code)
 values(p_organization_id,p_product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,'')));
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'receive_stock',fp,result,now()); return result;
end $$;
revoke all on function public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text) from public,anon,authenticated;
grant execute on function public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text) to authenticated;

alter table public.catalog_purchase_receipts add column if not exists lot_code text not null default '';
alter table public.catalog_purchase_receipts add column if not exists expires_on date;
alter table public.catalog_stock_ledger add column if not exists lot_code text not null default '';

drop function if exists public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid);
create or replace function public.receive_catalog_purchase_order_line(
 p_organization_id uuid,p_order_id uuid,p_line_id uuid,p_quantity integer,p_operation_id uuid,
 p_expires_on date default null,p_lot_code text default ''
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.catalog_purchase_orders%rowtype; l public.catalog_purchase_order_lines%rowtype; p public.catalog_products%rowtype; prior public.catalog_purchase_receipts%rowtype; rid uuid;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_quantity is null or p_quantity not between 1 and 999999 or p_operation_id is null or length(coalesce(p_lot_code,''))>120 then raise exception 'Invalid receipt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('purchase:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.catalog_purchase_receipts where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.order_id<>p_order_id or prior.order_line_id<>p_line_id or prior.quantity<>p_quantity or prior.received_by<>auth.uid() or prior.expires_on is distinct from p_expires_on or prior.lot_code<>btrim(coalesce(p_lot_code,'')) then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return jsonb_build_object('receipt_id',prior.id,'order_id',prior.order_id,'line_id',prior.order_line_id,'quantity',prior.quantity,'replayed',true);
 end if;
 select * into o from public.catalog_purchase_orders where organization_id=p_organization_id and id=p_order_id for update;
 if not found then raise exception 'Order not found' using errcode='P0002'; end if;
 if o.status not in ('ordered','received') then raise exception 'Order not open for receiving' using errcode='22023'; end if;
 select * into l from public.catalog_purchase_order_lines where organization_id=p_organization_id and order_id=p_order_id and id=p_line_id for update;
 if not found then raise exception 'Order line not found' using errcode='P0002'; end if;
 if l.quantity_received+p_quantity>l.quantity_ordered then raise exception 'Receipt exceeds remaining quantity' using errcode='22023'; end if;
 select * into p from public.catalog_products where organization_id=p_organization_id and id=l.product_id and kind='product' for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if p.stock_quantity+p_quantity>1000000000 then raise exception 'Invalid stock balance' using errcode='22023'; end if;
 insert into public.catalog_purchase_receipts(organization_id,order_id,order_line_id,product_id,quantity,operation_id,received_by,expires_on,lot_code)
 values(p_organization_id,p_order_id,p_line_id,l.product_id,p_quantity,p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,''))) returning id into rid;
 update public.catalog_purchase_order_lines set quantity_received=quantity_received+p_quantity where organization_id=p_organization_id and id=p_line_id;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where organization_id=p_organization_id and id=l.product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind,expires_on,lot_code)
 values(p_organization_id,l.product_id,p_quantity,'발주 입고 '||p_order_id::text,p_operation_id,auth.uid(),'purchase_order_receipt',p_expires_on,btrim(coalesce(p_lot_code,'')));
 if not exists(select 1 from public.catalog_purchase_order_lines where organization_id=p_organization_id and order_id=p_order_id and quantity_received<quantity_ordered) then
  update public.catalog_purchase_orders set status='received',version=version+1,updated_at=now() where organization_id=p_organization_id and id=p_order_id;
 end if;
 return jsonb_build_object('receipt_id',rid,'order_id',p_order_id,'line_id',p_line_id,'quantity',p_quantity,'replayed',false);
end $$;
revoke all on function public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text) from public,anon,authenticated;
grant execute on function public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text) to authenticated;

create or replace function public.list_catalog_inventory_lots(p_organization_id uuid,p_product_id uuid,p_expiring_within_days integer default 30)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'Catalog read permission required' using errcode='42501'; end if;
 if p_expiring_within_days not between 0 and 365 then raise exception 'Invalid alert range' using errcode='22023'; end if;
 if not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=p_product_id and kind='product') then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.expires_on asc nulls last,x.received_at,x.id) from (
  select id,organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,received_at,
   case when expires_on<current_date then 'expired' when expires_on<=current_date+p_expiring_within_days then 'expiring_soon' else 'ok' end as alert_status
  from public.catalog_inventory_lots where organization_id=p_organization_id and product_id=p_product_id and remaining_quantity>0
 ) x),'[]'::jsonb);
end $$;
revoke all on function public.list_catalog_inventory_lots(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_inventory_lots(uuid,uuid,integer) to authenticated;

commit;
