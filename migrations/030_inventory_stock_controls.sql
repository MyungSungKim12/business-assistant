-- INV-002: supplier returns, disposal and stocktake adjustments. Apply after 029; safe to reapply.
begin;

alter table public.catalog_stock_ledger
 add column if not exists movement_kind text;

update public.catalog_stock_ledger
 set movement_kind = case
  when sale_line_id is not null and quantity < 0 then 'sale'
  when sale_line_id is not null and quantity > 0 then 'refund'
  when quantity > 0 then 'receipt'
  else 'adjustment'
 end
where movement_kind is null;

alter table public.catalog_stock_ledger
 alter column movement_kind set default 'receipt',
 alter column movement_kind set not null;

alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_check;
alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_movement_check;
alter table public.catalog_stock_ledger
 add constraint catalog_stock_ledger_movement_check check (
  (movement_kind = 'receipt' and quantity > 0 and sale_line_id is null and operation_id is not null)
  or (movement_kind = 'sale' and quantity < 0 and sale_line_id is not null and operation_id is null)
  or (movement_kind = 'refund' and quantity > 0 and sale_line_id is not null and operation_id is null)
  or (movement_kind in ('supplier_return','disposal','stocktake') and quantity <> 0 and sale_line_id is null and operation_id is not null)
 );

create or replace function private.classify_catalog_sale_movement() returns trigger
 language plpgsql set search_path='' as $$
begin
 if new.sale_line_id is not null then
  if new.quantity < 0 then new.movement_kind='sale';
  elsif new.quantity > 0 then new.movement_kind='refund';
  else raise exception 'Sale stock movement cannot be zero' using errcode='22023';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.classify_catalog_sale_movement() from public,anon,authenticated;
drop trigger if exists classify_sale_movement on public.catalog_stock_ledger;
create trigger classify_sale_movement before insert on public.catalog_stock_ledger
 for each row execute function private.classify_catalog_sale_movement();

create index if not exists catalog_stock_ledger_product_history
 on public.catalog_stock_ledger(organization_id,product_id,created_at desc,id desc);

create or replace function public.list_catalog_stock_ledger(p_organization_id uuid,p_product_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Organization access denied' using errcode='42501';
 end if;
 if not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=p_product_id) then
  return '[]'::jsonb;
 end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc)
  from (select id,organization_id,product_id,movement_kind,quantity,reason,created_by,created_at
   from public.catalog_stock_ledger where organization_id=p_organization_id and product_id=p_product_id
   order by created_at desc,id desc limit 100) x),'[]'::jsonb);
end $$;
revoke all on function public.list_catalog_stock_ledger(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_catalog_stock_ledger(uuid,uuid) to authenticated;

create or replace function public.change_catalog_stock(
 p_organization_id uuid,p_product_id uuid,p_kind text,p_quantity integer,p_reason text,
 p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 fp text; prior public.sale_cart_operations%rowtype; product public.catalog_products%rowtype;
 delta integer; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_expected_version is null or p_expected_version < 1
  or p_kind is null or p_kind not in ('supplier_return','disposal','stocktake') or p_quantity is null
  or (p_kind in ('supplier_return','disposal') and p_quantity not between 1 and 999999)
  or (p_kind = 'stocktake' and p_quantity not between 0 and 1000000000)
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then
  raise exception 'Invalid stock adjustment' using errcode='22023';
 end if;
 fp=md5(jsonb_build_object('product',p_product_id,'kind',p_kind,'quantity',p_quantity,
  'reason',btrim(p_reason),'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'change_stock' or prior.request_fingerprint<>fp then
   raise exception 'Operation conflict' using errcode='P0001';
  end if;
  return private.catalog_payload(p_product_id);
 end if;
 select * into product from public.catalog_products
  where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.kind<>'product' then raise exception 'Stock applies to physical products only' using errcode='22023'; end if;
 if product.version<>p_expected_version then raise exception 'Product version conflict' using errcode='P0001'; end if;
 if p_kind='stocktake' then delta=p_quantity-product.stock_quantity; else delta=-p_quantity; end if;
 if product.stock_quantity+delta<0 or product.stock_quantity+delta>1000000000 then
  raise exception 'Invalid stock balance' using errcode='22023';
 end if;
 if delta<>0 then
  update public.catalog_products set stock_quantity=stock_quantity+delta,version=version+1
   where organization_id=p_organization_id and id=p_product_id;
  insert into public.catalog_stock_ledger(
   organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind
  ) values(p_organization_id,p_product_id,delta,btrim(p_reason),p_operation_id,auth.uid(),p_kind);
 end if;
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),'change_stock',fp,result);
 return result;
end $$;

revoke all on function public.change_catalog_stock(uuid,uuid,text,integer,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.change_catalog_stock(uuid,uuid,text,integer,text,bigint,uuid) to authenticated;

commit;
