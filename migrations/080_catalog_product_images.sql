-- INV-11: attach a private, size-limited image from the organization file library.
begin;

alter table public.catalog_products add column if not exists image_file_id uuid;
alter table public.catalog_products drop constraint if exists catalog_products_image_file_id_fkey;
alter table public.catalog_products add constraint catalog_products_image_file_id_fkey
 foreign key(image_file_id) references public.file_assets(id) on delete restrict;

create or replace function private.validate_catalog_product_image() returns trigger
language plpgsql security definer set search_path='' as $$
declare file public.file_assets%rowtype;
begin
 if new.image_file_id is null then return new; end if;
 select * into file from public.file_assets where id=new.image_file_id for share;
 if not found or file.organization_id<>new.organization_id or file.is_archived
  or file.size_bytes>5242880 or file.content_type not in ('image/jpeg','image/png','image/webp') then
  raise exception 'Invalid catalog product image' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function private.validate_catalog_product_image() from public,anon,authenticated;
drop trigger if exists catalog_product_image_valid on public.catalog_products;
create trigger catalog_product_image_valid before insert or update of organization_id,image_file_id on public.catalog_products
 for each row execute function private.validate_catalog_product_image();

create or replace function private.prevent_archiving_catalog_image() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.is_archived and not old.is_archived and exists(select 1 from public.catalog_products where image_file_id=old.id) then
  raise exception 'Unlink product image before archiving the file' using errcode='23503';
 end if;
 return new;
end $$;
revoke all on function private.prevent_archiving_catalog_image() from public,anon,authenticated;
drop trigger if exists prevent_archiving_catalog_image on public.file_assets;
create trigger prevent_archiving_catalog_image before update of is_archived on public.file_assets
 for each row execute function private.prevent_archiving_catalog_image();

create or replace function public.set_catalog_product_image(
 p_organization_id uuid,p_product_id uuid,p_image_file_id uuid,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare product public.catalog_products%rowtype; prior public.sale_cart_operations%rowtype; fp text; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_product_id is null or p_operation_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'Invalid product image request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('product',p_product_id,'image_file_id',p_image_file_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'catalog_product_image' or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into product from public.catalog_products where organization_id=p_organization_id and id=p_product_id for update;
 if not found then raise exception 'Product not found' using errcode='P0002'; end if;
 if product.version<>p_expected_version then raise exception 'Product version conflict' using errcode='P0001'; end if;
 update public.catalog_products set image_file_id=p_image_file_id,version=version+1 where organization_id=p_organization_id and id=p_product_id;
 result=private.catalog_payload(p_product_id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,request_fingerprint,result_snapshot,created_at)
  values(p_organization_id,p_operation_id,auth.uid(),'catalog_product_image',fp,result,now());
 return result;
end $$;
revoke all on function public.set_catalog_product_image(uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.set_catalog_product_image(uuid,uuid,uuid,bigint,uuid) to authenticated;

comment on column public.catalog_products.image_file_id is 'Optional private JPEG/PNG/WebP image from this organization file library (max 5 MiB).';
commit;
