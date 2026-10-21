-- INV-011: product category and organization-unique barcode. Apply after 066.
begin;

alter table public.catalog_products
 add column if not exists category text not null default '기타' check(length(btrim(category)) between 1 and 80),
 add column if not exists barcode text;
alter table public.catalog_products drop constraint if exists catalog_products_barcode_length;
alter table public.catalog_products add constraint catalog_products_barcode_length check(barcode is null or (barcode=btrim(barcode) and length(barcode) between 1 and 80));
create unique index if not exists catalog_products_organization_barcode
 on public.catalog_products(organization_id,barcode) where barcode is not null;

create or replace function public.set_catalog_product_metadata(
 p_organization_id uuid,p_product_id uuid,p_category text,p_barcode text,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare product public.catalog_products%rowtype; prior public.sale_cart_operations%rowtype; fp text; barcode_value text; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1
  or p_category is null or length(btrim(p_category)) not between 1 and 80
  or (p_barcode is not null and length(btrim(p_barcode))>80) then
  raise exception 'Invalid product metadata' using errcode='22023';
 end if;
 barcode_value=nullif(btrim(coalesce(p_barcode,'')),'');
 fp=md5(jsonb_build_object('product',p_product_id,'category',btrim(p_category),'barcode',barcode_value,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'catalog_metadata' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.version<>p_expected_version then raise exception 'Product version conflict' using errcode='P0001'; end if;
 update public.catalog_products set category=btrim(p_category),barcode=barcode_value,version=version+1
  where organization_id=p_organization_id and id=p_product_id;
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot,created_at)
  values(p_organization_id,p_operation_id,auth.uid(),'catalog_metadata',fp,result,now());
 return result;
end $$;
revoke all on function public.set_catalog_product_metadata(uuid,uuid,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.set_catalog_product_metadata(uuid,uuid,text,text,bigint,uuid) to authenticated;

commit;
