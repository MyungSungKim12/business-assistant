-- INV-11: purchase quantities can represent multiple inventory base units.
-- Acquisition cost is retained to six decimal places per base unit.
begin;

alter table public.catalog_products
 add column if not exists purchase_unit_name text not null default '개',
 add column if not exists units_per_purchase_unit integer not null default 1;
update public.catalog_products set purchase_unit_name=unit_name where purchase_unit_name='개' and unit_name<>'개';
alter table public.catalog_products drop constraint if exists catalog_products_purchase_unit_name_check;
alter table public.catalog_products add constraint catalog_products_purchase_unit_name_check check(length(btrim(purchase_unit_name)) between 1 and 30);
alter table public.catalog_products drop constraint if exists catalog_products_units_per_purchase_unit_check;
alter table public.catalog_products add constraint catalog_products_units_per_purchase_unit_check check(units_per_purchase_unit between 1 and 1000000);

alter table public.catalog_purchase_order_lines add column if not exists purchase_unit_name_snapshot text not null default '개';
alter table public.catalog_purchase_order_lines add column if not exists units_per_purchase_unit integer not null default 1;
update public.catalog_purchase_order_lines l set purchase_unit_name_snapshot=p.purchase_unit_name,units_per_purchase_unit=p.units_per_purchase_unit
 from public.catalog_products p where p.organization_id=l.organization_id and p.id=l.product_id;
alter table public.catalog_purchase_order_lines drop constraint if exists catalog_purchase_order_lines_purchase_unit_name_snapshot_check;
alter table public.catalog_purchase_order_lines add constraint catalog_purchase_order_lines_purchase_unit_name_snapshot_check check(length(btrim(purchase_unit_name_snapshot)) between 1 and 30);
alter table public.catalog_purchase_order_lines drop constraint if exists catalog_purchase_order_lines_units_per_purchase_unit_check;
alter table public.catalog_purchase_order_lines add constraint catalog_purchase_order_lines_units_per_purchase_unit_check check(units_per_purchase_unit between 1 and 1000000);

alter table public.catalog_purchase_receipts add column if not exists base_quantity integer not null default 0;
alter table public.catalog_purchase_receipts add column if not exists units_per_purchase_unit integer not null default 1;
alter table public.catalog_purchase_receipts add column if not exists base_unit_cost numeric(24,6);
update public.catalog_purchase_receipts r set base_quantity=r.quantity,units_per_purchase_unit=1,base_unit_cost=r.unit_cost
 where r.base_quantity=0;
alter table public.catalog_purchase_receipts drop constraint if exists catalog_purchase_receipts_base_quantity_check;
alter table public.catalog_purchase_receipts add constraint catalog_purchase_receipts_base_quantity_check check(base_quantity>0);
alter table public.catalog_purchase_receipts drop constraint if exists catalog_purchase_receipts_units_per_purchase_unit_check;
alter table public.catalog_purchase_receipts add constraint catalog_purchase_receipts_units_per_purchase_unit_check check(units_per_purchase_unit between 1 and 1000000);
alter table public.catalog_purchase_receipts drop constraint if exists catalog_purchase_receipts_base_unit_cost_check;
alter table public.catalog_purchase_receipts add constraint catalog_purchase_receipts_base_unit_cost_check check(base_unit_cost is null or base_unit_cost between 0 and 999999999999.999999);

alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_unit_cost_snapshot_check;
alter table public.catalog_stock_ledger alter column unit_cost_snapshot type numeric(24,6) using unit_cost_snapshot::numeric(24,6);
alter table public.catalog_stock_ledger add constraint catalog_stock_ledger_unit_cost_snapshot_check check(unit_cost_snapshot is null or unit_cost_snapshot between 0 and 999999999999.999999);
alter table public.catalog_inventory_lots drop constraint if exists catalog_inventory_lots_unit_cost_check;
alter table public.catalog_inventory_lots alter column unit_cost type numeric(24,6) using unit_cost::numeric(24,6);
alter table public.catalog_inventory_lots add constraint catalog_inventory_lots_unit_cost_check check(unit_cost is null or unit_cost between 0 and 999999999999.999999);
alter table public.catalog_stock_lot_allocations drop constraint if exists catalog_stock_lot_allocations_unit_cost_snapshot_check;
alter table public.catalog_stock_lot_allocations alter column unit_cost_snapshot type numeric(24,6) using unit_cost_snapshot::numeric(24,6);
alter table public.catalog_stock_lot_allocations drop constraint if exists catalog_stock_lot_allocations_extended_cost_check;
alter table public.catalog_stock_lot_allocations alter column extended_cost type numeric(24,6) using extended_cost::numeric(24,6);
alter table public.catalog_stock_lot_allocations add constraint catalog_stock_lot_allocations_unit_cost_snapshot_check check(unit_cost_snapshot is null or unit_cost_snapshot between 0 and 999999999999.999999);
alter table public.catalog_stock_lot_allocations add constraint catalog_stock_lot_allocations_extended_cost_check check(extended_cost is null or extended_cost>=0);

create or replace function private.track_catalog_stock_lot() returns trigger
language plpgsql security definer set search_path='' as $$
declare remaining integer; lot public.catalog_inventory_lots%rowtype; take integer; receipt_cost numeric(24,6);
begin
 if new.quantity>0 then
  receipt_cost=new.unit_cost_snapshot;
  if receipt_cost is null and new.movement_kind='refund' and new.sale_line_id is not null then
   select case when count(*)=count(a.unit_cost_snapshot) then round(sum(a.extended_cost)/nullif(sum(a.quantity),0),6) else null end
    into receipt_cost from public.catalog_stock_lot_allocations a join public.catalog_stock_ledger source on source.organization_id=a.organization_id and source.id=a.movement_id
    where source.organization_id=new.organization_id and source.sale_line_id=new.sale_line_id and source.movement_kind='sale';
  end if;
  insert into public.catalog_inventory_lots(organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,received_at,created_by,source_movement_id,unit_cost)
  values(new.organization_id,new.product_id,coalesce(nullif(btrim(new.lot_code),''),''),new.quantity,new.quantity,new.expires_on,new.created_at,new.created_by,new.id,receipt_cost)
  on conflict(source_movement_id) do nothing;
  return null;
 end if;
 remaining=-new.quantity;
 for lot in select * from public.catalog_inventory_lots where organization_id=new.organization_id and product_id=new.product_id and remaining_quantity>0
   and (expires_on is null or expires_on>=current_date) order by expires_on asc nulls last,received_at asc,id asc for update loop
  take=least(remaining,lot.remaining_quantity);
  update public.catalog_inventory_lots set remaining_quantity=remaining_quantity-take where organization_id=lot.organization_id and id=lot.id;
  insert into public.catalog_stock_lot_allocations(organization_id,movement_id,lot_id,quantity,unit_cost_snapshot,extended_cost)
  values(new.organization_id,new.id,lot.id,take,lot.unit_cost,case when lot.unit_cost is null then null else lot.unit_cost*take end);
  remaining=remaining-take; exit when remaining=0;
 end loop;
 if remaining>0 then raise exception 'Insufficient unexpired lot stock' using errcode='P0001'; end if;
 return null;
end $$;

create or replace function public.save_catalog_product(p_organization_id uuid,p_product_id uuid,p_expected_version bigint,p_operation_id uuid,p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb; v jsonb; product_id uuid; purchase_unit text; unit_factor integer;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_operation_id is null or p_values is null or jsonb_typeof(p_values)<>'object' or p_values='{}'::jsonb
  or p_values-array['sku','name','kind','unit_name','sale_price','benefit_money','benefit_count','valid_days','is_active','purchase_unit_name','units_per_purchase_unit']<>'{}'::jsonb
  or (p_product_id is null and p_expected_version is not null) or (p_product_id is not null and (p_expected_version is null or p_expected_version<1)) then
  raise exception 'Invalid catalog request' using errcode='22023'; end if;
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
 purchase_unit=coalesce(v->>'purchase_unit_name',v->>'unit_name'); unit_factor=coalesce((v->>'units_per_purchase_unit')::integer,1);
 if not(v ?& array['sku','name','kind','unit_name','sale_price']) or jsonb_typeof(v->'sku')<>'string' or length(btrim(v->>'sku')) not between 1 and 80
  or jsonb_typeof(v->'name')<>'string' or length(btrim(v->>'name')) not between 1 and 200 or jsonb_typeof(v->'unit_name')<>'string' or length(btrim(v->>'unit_name')) not between 1 and 30
  or jsonb_typeof(v->'kind')<>'string' or v->>'kind' not in ('product','membership') or jsonb_typeof(v->'sale_price')<>'string' or (v->>'sale_price')!~'^[1-9][0-9]{0,11}$'
  or jsonb_typeof(v->'benefit_money')<>'string' or (v->>'benefit_money')!~'^(0|[1-9][0-9]{0,11})$' or jsonb_typeof(v->'benefit_count')<>'number' or (v->>'benefit_count')!~'^(0|[1-9][0-9]{0,5})$'
  or jsonb_typeof(v->'is_active')<>'boolean' or (jsonb_typeof(v->'valid_days')<>'null' and (jsonb_typeof(v->'valid_days')<>'number' or (v->>'valid_days')!~'^[1-9][0-9]{0,3}$'))
  or length(btrim(purchase_unit)) not between 1 and 30 or unit_factor not between 1 and 1000000 then raise exception 'Invalid catalog values' using errcode='22023'; end if;
 if ((v->>'valid_days')::integer is not null and (v->>'valid_days')::integer not between 1 and 3650)
  or (v->>'kind'='product' and ((v->>'benefit_money')::numeric<>0 or (v->>'benefit_count')::integer<>0 or v->>'valid_days' is not null))
  or (v->>'kind'='membership' and (v->>'benefit_money')::numeric=0 and (v->>'benefit_count')::integer=0)
  or (p_product_id is not null and product.kind<>v->>'kind') or (v->>'kind'='membership' and (purchase_unit<>v->>'unit_name' or unit_factor<>1)) then
  raise exception 'Invalid catalog benefits or kind' using errcode='22023'; end if;
 if p_product_id is null then
  insert into public.catalog_products(organization_id,sku,name,kind,unit_name,purchase_unit_name,units_per_purchase_unit,sale_price,benefit_money,benefit_count,valid_days,is_active)
  values(p_organization_id,btrim(v->>'sku'),btrim(v->>'name'),v->>'kind',btrim(v->>'unit_name'),btrim(purchase_unit),unit_factor,(v->>'sale_price')::numeric,(v->>'benefit_money')::numeric,(v->>'benefit_count')::integer,(v->>'valid_days')::integer,(v->>'is_active')::boolean) returning id into product_id;
 else
  update public.catalog_products set sku=btrim(v->>'sku'),name=btrim(v->>'name'),unit_name=btrim(v->>'unit_name'),purchase_unit_name=btrim(purchase_unit),units_per_purchase_unit=unit_factor,sale_price=(v->>'sale_price')::numeric,benefit_money=(v->>'benefit_money')::numeric,benefit_count=(v->>'benefit_count')::integer,valid_days=(v->>'valid_days')::integer,is_active=(v->>'is_active')::boolean,version=version+1 where organization_id=p_organization_id and id=p_product_id returning id into product_id;
 end if;
 result=private.catalog_payload(product_id);insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'save_catalog',fp,result,now());return result;
end $$;

alter table public.catalog_purchase_order_lines add column if not exists purchase_unit_name_snapshot text not null default '개';
alter table public.catalog_purchase_order_lines add column if not exists units_per_purchase_unit integer not null default 1;
update public.catalog_purchase_order_lines l set purchase_unit_name_snapshot=p.purchase_unit_name,units_per_purchase_unit=p.units_per_purchase_unit from public.catalog_products p where p.organization_id=l.organization_id and p.id=l.product_id;

create or replace function public.create_catalog_purchase_order(p_organization_id uuid,p_supplier_id uuid,p_operation_id uuid,p_note text,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.catalog_purchase_orders%rowtype; o public.catalog_purchase_orders%rowtype; item jsonb; pid uuid; qty integer; cost bigint; line_note text; fp text; p public.catalog_products%rowtype;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_operation_id is null or p_note is null or length(p_note)>2000 or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Invalid purchase order' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('supplier',p_supplier_id,'note',btrim(p_note),'lines',p_lines)::text);perform pg_advisory_xact_lock(hashtextextended('purchase-order:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.catalog_purchase_orders where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.request_fingerprint<>fp or prior.created_by<>auth.uid() then raise exception 'Operation conflict' using errcode='P0001'; end if; return jsonb_build_object('id',prior.id,'organization_id',prior.organization_id,'supplier_id',prior.supplier_id,'status',prior.status,'ordered_at',prior.ordered_at,'note',prior.note,'version',prior.version,'created_by',prior.created_by,'created_at',prior.created_at,'updated_at',prior.updated_at,'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at,l.id),'[]'::jsonb) from public.catalog_purchase_order_lines l where l.organization_id=p_organization_id and l.order_id=prior.id)); end if;
 if not exists(select 1 from public.catalog_suppliers where organization_id=p_organization_id and id=p_supplier_id and is_active) then raise exception 'Supplier not found' using errcode='P0002'; end if;
 insert into public.catalog_purchase_orders(organization_id,supplier_id,operation_id,request_fingerprint,note,created_by) values(p_organization_id,p_supplier_id,p_operation_id,fp,btrim(p_note),auth.uid()) returning * into o;
 for item in select value from jsonb_array_elements(p_lines) loop
  pid=(item->>'product_id')::uuid;qty=(item->>'quantity_ordered')::integer;cost=(item->>'unit_cost')::bigint;line_note=coalesce(item->>'note','');
  select * into p from public.catalog_products where organization_id=p_organization_id and id=pid and kind='product' and is_active for share;
  if qty not between 1 and 999999 or cost not between 0 and 999999999999 or length(line_note)>500 or not found then raise exception 'Invalid purchase line' using errcode='22023'; end if;
  insert into public.catalog_purchase_order_lines(organization_id,order_id,product_id,quantity_ordered,unit_cost,note,purchase_unit_name_snapshot,units_per_purchase_unit)
   values(p_organization_id,o.id,pid,qty,cost,line_note,p.purchase_unit_name,p.units_per_purchase_unit);
 end loop;
 return jsonb_build_object('id',o.id,'organization_id',o.organization_id,'supplier_id',o.supplier_id,'status',o.status,'ordered_at',o.ordered_at,'note',o.note,'version',o.version,'created_by',o.created_by,'created_at',o.created_at,'updated_at',o.updated_at,'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at,l.id),'[]'::jsonb) from public.catalog_purchase_order_lines l where l.organization_id=p_organization_id and l.order_id=o.id));
end $$;

drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text);
drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,bigint);
drop function if exists public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,numeric);
create function public.receive_catalog_stock(p_organization_id uuid,p_product_id uuid,p_quantity integer,p_reason text,p_operation_id uuid,p_expires_on date default null,p_lot_code text default '',p_unit_cost numeric default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_quantity not between 1 and 999999 or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or length(coalesce(p_lot_code,''))>120 or (p_unit_cost is not null and p_unit_cost not between 0 and 999999999999.999999) then raise exception 'Invalid stock receipt' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('product',p_product_id,'quantity',p_quantity,'reason',btrim(p_reason),'expires_on',p_expires_on,'lot_code',btrim(coalesce(p_lot_code,'')),'unit_cost',p_unit_cost)::text);perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.actor_id<>auth.uid() or prior.action<>'receive_stock' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;return prior.result_snapshot;end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002';end if;
 if product.kind<>'product' or product.stock_quantity::bigint+p_quantity>1000000000 then raise exception 'Invalid stock balance' using errcode='22023';end if;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where organization_id=p_organization_id and id=p_product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,expires_on,lot_code,unit_cost_snapshot) values(p_organization_id,p_product_id,p_quantity,btrim(p_reason),p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,'')),p_unit_cost);
 result=private.catalog_payload(p_product_id);insert into public.sale_cart_operations values(p_organization_id,p_operation_id,auth.uid(),'receive_stock',fp,result,now());return result;
end $$;

alter table public.catalog_purchase_receipts add column if not exists base_quantity integer not null default 0;
alter table public.catalog_purchase_receipts add column if not exists units_per_purchase_unit integer not null default 1;
alter table public.catalog_purchase_receipts add column if not exists base_unit_cost numeric(24,6);
update public.catalog_purchase_receipts r set base_quantity=r.quantity,units_per_purchase_unit=1,base_unit_cost=r.unit_cost where base_quantity=0;

drop function if exists public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text);
create function public.receive_catalog_purchase_order_line(p_organization_id uuid,p_order_id uuid,p_line_id uuid,p_quantity integer,p_operation_id uuid,p_expires_on date default null,p_lot_code text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.catalog_purchase_orders%rowtype;l public.catalog_purchase_order_lines%rowtype;p public.catalog_products%rowtype;prior public.catalog_purchase_receipts%rowtype;rid uuid;base_qty integer;base_cost numeric(24,6);
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_quantity not between 1 and 999999 or p_operation_id is null or length(coalesce(p_lot_code,''))>120 then raise exception 'Invalid receipt' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('purchase:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.catalog_purchase_receipts where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.order_id<>p_order_id or prior.order_line_id<>p_line_id or prior.quantity<>p_quantity or prior.received_by<>auth.uid() or prior.expires_on is distinct from p_expires_on or prior.lot_code<>btrim(coalesce(p_lot_code,'')) then raise exception 'Operation conflict' using errcode='P0001';end if;return jsonb_build_object('receipt_id',prior.id,'order_id',prior.order_id,'line_id',prior.order_line_id,'quantity',prior.quantity,'base_quantity',prior.base_quantity,'replayed',true);end if;
 select * into o from public.catalog_purchase_orders where organization_id=p_organization_id and id=p_order_id for update;if not found then raise exception 'Order not found' using errcode='P0002';end if;
 if o.status not in ('ordered','received') then raise exception 'Order not open for receiving' using errcode='22023';end if;
 select * into l from public.catalog_purchase_order_lines where organization_id=p_organization_id and order_id=p_order_id and id=p_line_id for update;if not found then raise exception 'Order line not found' using errcode='P0002';end if;
 if l.quantity_received+p_quantity>l.quantity_ordered then raise exception 'Receipt exceeds remaining quantity' using errcode='22023';end if;
 base_qty=p_quantity*l.units_per_purchase_unit;if base_qty>999999999 then raise exception 'Invalid base quantity' using errcode='22023';end if;
 select * into p from public.catalog_products where organization_id=p_organization_id and id=l.product_id and kind='product' for update;if not found then raise exception 'Product not found' using errcode='P0002';end if;
 if p.stock_quantity::bigint+base_qty>1000000000 then raise exception 'Invalid stock balance' using errcode='22023';end if;
 base_cost=round(l.unit_cost::numeric/l.units_per_purchase_unit,6);
 insert into public.catalog_purchase_receipts(organization_id,order_id,order_line_id,product_id,quantity,base_quantity,units_per_purchase_unit,base_unit_cost,operation_id,received_by,expires_on,lot_code,unit_cost)
 values(p_organization_id,p_order_id,p_line_id,l.product_id,p_quantity,base_qty,l.units_per_purchase_unit,base_cost,p_operation_id,auth.uid(),p_expires_on,btrim(coalesce(p_lot_code,'')),l.unit_cost) returning id into rid;
 update public.catalog_purchase_order_lines set quantity_received=quantity_received+p_quantity where organization_id=p_organization_id and id=p_line_id;
 update public.catalog_products set stock_quantity=stock_quantity+base_qty,version=version+1 where organization_id=p_organization_id and id=l.product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind,expires_on,lot_code,unit_cost_snapshot)
 values(p_organization_id,l.product_id,base_qty,'발주 입고 '||p_order_id::text,p_operation_id,auth.uid(),'purchase_order_receipt',p_expires_on,btrim(coalesce(p_lot_code,'')),base_cost);
 if not exists(select 1 from public.catalog_purchase_order_lines where organization_id=p_organization_id and order_id=p_order_id and quantity_received<quantity_ordered) then update public.catalog_purchase_orders set status='received',version=version+1,updated_at=now() where organization_id=p_organization_id and id=p_order_id;end if;
 return jsonb_build_object('receipt_id',rid,'order_id',p_order_id,'line_id',p_line_id,'quantity',p_quantity,'base_quantity',base_qty,'replayed',false);
end $$;

create or replace function public.list_catalog_inventory_lots(p_organization_id uuid,p_product_id uuid,p_expiring_within_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'Catalog read permission required' using errcode='42501';end if;
 if p_expiring_within_days not between 0 and 365 then raise exception 'Invalid alert range' using errcode='22023';end if;
 if not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=p_product_id and kind='product') then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.expires_on asc nulls last,x.received_at,x.id) from (select id,organization_id,product_id,lot_code,received_quantity,remaining_quantity,expires_on,unit_cost::text unit_cost,received_at,case when expires_on<current_date then 'expired' when expires_on<=current_date+p_expiring_within_days then 'expiring_soon' else 'ok' end alert_status from public.catalog_inventory_lots where organization_id=p_organization_id and product_id=p_product_id and remaining_quantity>0)x),'[]'::jsonb);
end $$;

revoke all on function public.save_catalog_product(uuid,uuid,bigint,uuid,jsonb),public.create_catalog_purchase_order(uuid,uuid,uuid,text,jsonb),public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,numeric),public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text),public.list_catalog_inventory_lots(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.save_catalog_product(uuid,uuid,bigint,uuid,jsonb),public.create_catalog_purchase_order(uuid,uuid,uuid,text,jsonb),public.receive_catalog_stock(uuid,uuid,integer,text,uuid,date,text,numeric),public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid,date,text),public.list_catalog_inventory_lots(uuid,uuid,integer) to authenticated;
commit;
