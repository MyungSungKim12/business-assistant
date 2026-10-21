-- INV-003: one organization-wide query for expiring/expired inventory lots.
begin;

create index if not exists catalog_inventory_lots_org_expiry_alerts
 on public.catalog_inventory_lots(organization_id,expires_on,received_at,id) include(product_id)
 where remaining_quantity>0 and expires_on is not null;

drop function if exists public.list_catalog_inventory_lot_alerts(uuid,integer,integer);
drop function if exists public.list_catalog_inventory_lot_alerts(uuid,integer,integer,integer);
create function public.list_catalog_inventory_lot_alerts(
 p_organization_id uuid,p_expiring_within_days integer default 30,p_limit integer default 200,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Catalog read permission required' using errcode='42501'; end if;
 if p_expiring_within_days is null or p_expiring_within_days not between 0 and 365 or p_limit is null or p_limit not between 1 and 200
  or p_offset is null or p_offset not between 0 and 5000 then
  raise exception 'Invalid inventory lot alert range' using errcode='22023'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.expires_on,x.received_at,x.id) from (
  select l.id,l.organization_id,l.product_id,p.name as product_name,l.lot_code,l.received_quantity,l.remaining_quantity,l.expires_on,l.unit_cost,l.received_at,
   case when l.expires_on<current_date then 'expired' else 'expiring_soon' end as alert_status
  from public.catalog_inventory_lots l
  join public.catalog_products p on p.organization_id=l.organization_id and p.id=l.product_id
  where l.organization_id=p_organization_id and p.kind='product' and l.remaining_quantity>0
   and l.expires_on<=current_date+p_expiring_within_days
  order by l.expires_on,l.received_at,l.id limit p_limit offset p_offset
 ) x),'[]'::jsonb);
end $$;
revoke all on function public.list_catalog_inventory_lot_alerts(uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.list_catalog_inventory_lot_alerts(uuid,integer,integer,integer) to authenticated;

commit;
