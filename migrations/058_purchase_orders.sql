-- INV-11: suppliers, purchase orders and atomic partial receiving.
begin;
create table if not exists public.catalog_suppliers (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 160), contact_name text not null default '' check(length(contact_name)<=120),
 phone text not null default '' check(length(phone)<=40), email text not null default '' check(length(email)<=254), note text not null default '' check(length(note)<=2000),
 is_active boolean not null default true, version bigint not null default 1 check(version>0), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,name)
);
create table if not exists public.catalog_purchase_orders (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 supplier_id uuid not null, operation_id uuid not null, status text not null default 'draft' check(status in ('draft','ordered','received','canceled')),
 ordered_at timestamptz, note text not null default '' check(length(note)<=2000), version bigint not null default 1 check(version>0),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,operation_id), foreign key(supplier_id,organization_id) references public.catalog_suppliers(id,organization_id) on delete restrict
);
alter table public.catalog_purchase_orders add column if not exists operation_id uuid;
alter table public.catalog_purchase_orders add column if not exists request_fingerprint text;
update public.catalog_purchase_orders set operation_id=id,request_fingerprint=md5(id::text) where operation_id is null or request_fingerprint is null;
alter table public.catalog_purchase_orders alter column operation_id set not null;
alter table public.catalog_purchase_orders alter column request_fingerprint set not null;
create table if not exists public.catalog_purchase_order_lines (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null, product_id uuid not null,
 quantity_ordered integer not null check(quantity_ordered between 1 and 999999), quantity_received integer not null default 0 check(quantity_received between 0 and quantity_ordered),
 unit_cost bigint not null default 0 check(unit_cost between 0 and 999999999999), note text not null default '' check(length(note)<=500),
 created_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,order_id,product_id),
 foreign key(order_id,organization_id) references public.catalog_purchase_orders(id,organization_id) on delete cascade,
 foreign key(product_id,organization_id) references public.catalog_products(id,organization_id) on delete restrict
);
create table if not exists public.catalog_purchase_receipts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null, order_line_id uuid not null,
 product_id uuid not null, quantity integer not null check(quantity>0), operation_id uuid not null, received_by uuid not null references auth.users(id), received_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,operation_id),
 foreign key(order_id,organization_id) references public.catalog_purchase_orders(id,organization_id) on delete restrict,
 foreign key(order_line_id,organization_id) references public.catalog_purchase_order_lines(id,organization_id) on delete restrict,
 foreign key(product_id,organization_id) references public.catalog_products(id,organization_id) on delete restrict
);
create index if not exists catalog_purchase_orders_recent on public.catalog_purchase_orders(organization_id,created_at desc,id desc);
create index if not exists catalog_purchase_lines_order on public.catalog_purchase_order_lines(organization_id,order_id);
create index if not exists catalog_purchase_receipts_order on public.catalog_purchase_receipts(organization_id,order_id,received_at desc);
alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_movement_check;
alter table public.catalog_stock_ledger add constraint catalog_stock_ledger_movement_check check (
 (movement_kind='receipt' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='purchase_order_receipt' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='sale' and quantity<0 and sale_line_id is not null and operation_id is null)
 or (movement_kind='refund' and quantity>0 and sale_line_id is not null and operation_id is null)
 or (movement_kind in ('supplier_return','disposal','stocktake') and quantity<>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='customer_return' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind in ('adjustment','treatment_use') and quantity<>0 and sale_line_id is null and operation_id is not null)
);
do $$ declare t text; begin foreach t in array array['catalog_suppliers','catalog_purchase_orders','catalog_purchase_order_lines','catalog_purchase_receipts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('drop policy if exists %I on public.%I',t||'_member_select',t);
 execute format('drop policy if exists %I on public.%I',t||'_manager_all',t);
 execute format('create policy %I on public.%I for select to authenticated using ((select private.has_organization_role(organization_id,array[''owner'',''admin'',''member'']::text[])))',t||'_member_select',t);
 end loop; end $$;
revoke insert,update,delete on public.catalog_suppliers,public.catalog_purchase_orders,public.catalog_purchase_order_lines,public.catalog_purchase_receipts from authenticated;
grant select on public.catalog_suppliers,public.catalog_purchase_orders,public.catalog_purchase_order_lines,public.catalog_purchase_receipts to authenticated;
create or replace function public.receive_catalog_purchase_order_line(p_organization_id uuid,p_order_id uuid,p_line_id uuid,p_quantity integer,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.catalog_purchase_orders%rowtype; l public.catalog_purchase_order_lines%rowtype; p public.catalog_products%rowtype; prior public.catalog_purchase_receipts%rowtype; rid uuid;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_quantity is null or p_quantity not between 1 and 999999 or p_operation_id is null then raise exception 'Invalid receipt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('purchase:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.catalog_purchase_receipts where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.order_id<>p_order_id or prior.order_line_id<>p_line_id or prior.quantity<>p_quantity or prior.received_by<>auth.uid() then raise exception 'Operation conflict' using errcode='P0001'; end if;
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
 insert into public.catalog_purchase_receipts(organization_id,order_id,order_line_id,product_id,quantity,operation_id,received_by)
 values(p_organization_id,p_order_id,p_line_id,l.product_id,p_quantity,p_operation_id,auth.uid()) returning id into rid;
 update public.catalog_purchase_order_lines set quantity_received=quantity_received+p_quantity where organization_id=p_organization_id and id=p_line_id;
 update public.catalog_products set stock_quantity=stock_quantity+p_quantity,version=version+1 where organization_id=p_organization_id and id=l.product_id;
 insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
 values(p_organization_id,l.product_id,p_quantity,'발주 입고 '||p_order_id::text,p_operation_id,auth.uid(),'purchase_order_receipt');
 if not exists(select 1 from public.catalog_purchase_order_lines where organization_id=p_organization_id and order_id=p_order_id and quantity_received<quantity_ordered) then
  update public.catalog_purchase_orders set status='received',version=version+1,updated_at=now() where organization_id=p_organization_id and id=p_order_id;
 end if;
 return jsonb_build_object('receipt_id',rid,'order_id',p_order_id,'line_id',p_line_id,'quantity',p_quantity,'replayed',false);
end $$;
revoke all on function public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.receive_catalog_purchase_order_line(uuid,uuid,uuid,integer,uuid) to authenticated;

create or replace function public.create_catalog_supplier(p_organization_id uuid,p_values jsonb) returns public.catalog_suppliers
language plpgsql security definer set search_path='' as $$ declare s public.catalog_suppliers%rowtype; begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if jsonb_typeof(p_values)<>'object' or length(btrim(coalesce(p_values->>'name','')))=0 or length(p_values->>'name')>160 then raise exception 'Invalid supplier' using errcode='22023'; end if;
 insert into public.catalog_suppliers(organization_id,name,contact_name,phone,email,note,is_active,created_by)
 values(p_organization_id,btrim(p_values->>'name'),coalesce(p_values->>'contact_name',''),coalesce(p_values->>'phone',''),coalesce(p_values->>'email',''),coalesce(p_values->>'note',''),coalesce((p_values->>'is_active')::boolean,true),auth.uid()) returning * into s;
 return s;
end $$;
create or replace function public.create_catalog_purchase_order(p_organization_id uuid,p_supplier_id uuid,p_operation_id uuid,p_note text,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.catalog_purchase_orders%rowtype; o public.catalog_purchase_orders%rowtype; item jsonb; pid uuid; qty integer; cost bigint; line_note text; fp text;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_operation_id is null or p_note is null or length(p_note)>2000 or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Invalid purchase order' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('supplier',p_supplier_id,'note',btrim(p_note),'lines',p_lines)::text);
 perform pg_advisory_xact_lock(hashtextextended('purchase-order:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.catalog_purchase_orders where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.request_fingerprint<>fp or prior.created_by<>auth.uid() then raise exception 'Operation conflict' using errcode='P0001'; end if; return jsonb_build_object('id',prior.id,'organization_id',prior.organization_id,'supplier_id',prior.supplier_id,'status',prior.status,'ordered_at',prior.ordered_at,'note',prior.note,'version',prior.version,'created_by',prior.created_by,'created_at',prior.created_at,'updated_at',prior.updated_at,'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at,l.id),'[]'::jsonb) from public.catalog_purchase_order_lines l where l.organization_id=p_organization_id and l.order_id=prior.id)); end if;
 if not exists(select 1 from public.catalog_suppliers where organization_id=p_organization_id and id=p_supplier_id and is_active) then raise exception 'Supplier not found' using errcode='P0002'; end if;
 insert into public.catalog_purchase_orders(organization_id,supplier_id,operation_id,request_fingerprint,note,created_by) values(p_organization_id,p_supplier_id,p_operation_id,fp,btrim(p_note),auth.uid()) returning * into o;
 for item in select value from jsonb_array_elements(p_lines) loop
  pid=(item->>'product_id')::uuid; qty=(item->>'quantity_ordered')::integer; cost=(item->>'unit_cost')::bigint; line_note=coalesce(item->>'note','');
  if qty not between 1 and 999999 or cost not between 0 and 999999999999 or length(line_note)>500 or not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=pid and kind='product' and is_active) then raise exception 'Invalid purchase line' using errcode='22023'; end if;
  insert into public.catalog_purchase_order_lines(organization_id,order_id,product_id,quantity_ordered,unit_cost,note) values(p_organization_id,o.id,pid,qty,cost,line_note);
 end loop;
 return jsonb_build_object('id',o.id,'organization_id',o.organization_id,'supplier_id',o.supplier_id,'status',o.status,'ordered_at',o.ordered_at,'note',o.note,'version',o.version,'created_by',o.created_by,'created_at',o.created_at,'updated_at',o.updated_at,'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at,l.id),'[]'::jsonb) from public.catalog_purchase_order_lines l where l.organization_id=p_organization_id and l.order_id=o.id));
end $$;
create or replace function public.update_catalog_purchase_order(p_organization_id uuid,p_order_id uuid,p_status text,p_expected_version bigint)
returns public.catalog_purchase_orders language plpgsql security definer set search_path='' as $$ declare o public.catalog_purchase_orders%rowtype; begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_status not in ('ordered','canceled') or p_expected_version<1 then raise exception 'Invalid purchase order status' using errcode='22023'; end if;
 select * into o from public.catalog_purchase_orders where organization_id=p_organization_id and id=p_order_id for update;
 if not found then raise exception 'Purchase order not found' using errcode='P0002'; end if;
 if o.version<>p_expected_version or o.status not in ('draft','ordered') or (o.status='ordered' and p_status='ordered') then raise exception 'Purchase order conflict' using errcode='P0001'; end if;
 update public.catalog_purchase_orders set status=p_status,ordered_at=case when p_status='ordered' then now() else null end,version=version+1,updated_at=now() where organization_id=p_organization_id and id=p_order_id returning * into o; return o;
end $$;
revoke all on function public.create_catalog_supplier(uuid,jsonb),public.create_catalog_purchase_order(uuid,uuid,uuid,text,jsonb),public.update_catalog_purchase_order(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.create_catalog_supplier(uuid,jsonb),public.create_catalog_purchase_order(uuid,uuid,uuid,text,jsonb),public.update_catalog_purchase_order(uuid,uuid,text,bigint) to authenticated;
commit;
