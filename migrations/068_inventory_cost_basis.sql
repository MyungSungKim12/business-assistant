-- LAB-10 / TEAM-11 foundation: retain known acquisition cost per lot and snapshot it on consumption.
-- NULL means the historical/manual source has no reliable cost; it must never be reported as zero.
begin;

alter table public.catalog_stock_ledger add column if not exists unit_cost_snapshot bigint
 check(unit_cost_snapshot is null or unit_cost_snapshot between 0 and 999999999999);
alter table public.catalog_inventory_lots add column if not exists unit_cost bigint
 check(unit_cost is null or unit_cost between 0 and 999999999999);
alter table public.catalog_stock_lot_allocations add column if not exists unit_cost_snapshot bigint
 check(unit_cost_snapshot is null or unit_cost_snapshot between 0 and 999999999999);
alter table public.catalog_stock_lot_allocations add column if not exists extended_cost numeric(24,0)
 check(extended_cost is null or extended_cost>=0);

create or replace function private.track_catalog_stock_lot() returns trigger
 language plpgsql security definer set search_path='' as $$
declare remaining integer; lot public.catalog_inventory_lots%rowtype; take integer; receipt_cost bigint;
begin
 if new.quantity>0 then
  receipt_cost=new.unit_cost_snapshot;
  if receipt_cost is null and new.movement_kind='refund' and new.sale_line_id is not null then
   select case when count(*)=count(a.unit_cost_snapshot) then round(sum(a.extended_cost)/nullif(sum(a.quantity),0))::bigint else null end
    into receipt_cost from public.catalog_stock_lot_allocations a join public.catalog_stock_ledger source
     on source.organization_id=a.organization_id and source.id=a.movement_id
    where source.organization_id=new.organization_id and source.sale_line_id=new.sale_line_id and source.movement_kind='sale';
  end if;
  insert into public.catalog_inventory_lots(organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,received_at,created_by,source_movement_id,unit_cost)
  values(new.organization_id,new.product_id,coalesce(nullif(btrim(new.lot_code),''),''),new.quantity,new.quantity,new.expires_on,new.created_at,new.created_by,new.id,receipt_cost)
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
  insert into public.catalog_stock_lot_allocations(organization_id,movement_id,lot_id,quantity,unit_cost_snapshot,extended_cost)
   values(new.organization_id,new.id,lot.id,take,lot.unit_cost,case when lot.unit_cost is null then null else lot.unit_cost*take end);
  remaining=remaining-take;
  exit when remaining=0;
 end loop;
 if remaining>0 then raise exception 'Insufficient unexpired lot stock' using errcode='P0001'; end if;
 return null;
end $$;
revoke all on function private.track_catalog_stock_lot() from public,anon,authenticated;

-- Rebuild the 066 overload: cost is part of the retry fingerprint and is immutable after receipt.
drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text);
drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,bigint);
create function public.receive_catalog_stock(
 p_organization_id uuid,p_product_id uuid,p_quantity integer,p_reason text,p_operation_id uuid,
 p_expires_on date default null,p_lot_code text default '',p_unit_cost bigint default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_quantity is null or p_quantity not between 1 and 999999
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or length(coalesce(p_lot_code,''))>120
  or (p_unit_cost is not null and p_unit_cost not between 0 and 999999999999) then raise exception 'Invalid stock receipt' using errcode='22023'; end if;
 if p_expires_on is null and btrim(coalesce(p_lot_code,''))='' and p_unit_cost is null then
  fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',p_reason)::text);
 else
  fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',btrim(p_reason),'expires_on',p_expires_on,'lot_code',btrim(coalesce(p_lot_code,'')),'unit_cost',p_unit_cost)::text);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'receive_stock' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if; return prior.result_snapshot; end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.kind<>'product' or product.stock_quantity::bigint+p_quantity>1000000000 then raise exception 'Invalid stock balance' using errcode='22023'; end if;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where id=p_product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,expires_on,lot_code,unit_cost_snapshot)
 values(p_organization_id,p_product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,'')),p_unit_cost);
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'receive_stock',fp,result,now()); return result;
end $$;
revoke all on function public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,bigint) from public,anon,authenticated;
grant execute on function public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,bigint) to authenticated;

alter table public.catalog_purchase_receipts add column if not exists unit_cost bigint
 check(unit_cost is null or unit_cost between 0 and 999999999999);
-- Keep 066's behavior and exact retry checks while carrying the purchase order's entered unit cost into the lot.
drop function if exists public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text);
create function public.receive_catalog_purchase_order_line(
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
 insert into public.catalog_purchase_receipts(organization_id,order_id,order_line_id,product_id,quantity,operation_id,received_by,expires_on,lot_code,unit_cost)
 values(p_organization_id,p_order_id,p_line_id,l.product_id,p_quantity,p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,'')),l.unit_cost) returning id into rid;
 update public.catalog_purchase_order_lines set quantity_received=quantity_received+p_quantity where organization_id=p_organization_id and id=p_line_id;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where organization_id=p_organization_id and id=l.product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind,expires_on,lot_code,unit_cost_snapshot)
 values(p_organization_id,l.product_id,p_quantity,'발주 입고 '||p_order_id::text,p_operation_id,auth.uid(),'purchase_order_receipt',p_expires_on,btrim(coalesce(p_lot_code,'')),l.unit_cost);
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
  select id,organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,unit_cost,received_at,
   case when expires_on<current_date then 'expired' when expires_on<=current_date+p_expiring_within_days then 'expiring_soon' else 'ok' end as alert_status
  from public.catalog_inventory_lots where organization_id=p_organization_id and product_id=p_product_id and remaining_quantity>0
 ) x),'[]'::jsonb);
end $$;
revoke all on function public.list_catalog_inventory_lots(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_inventory_lots(uuid,uuid,integer) to authenticated;

commit;
