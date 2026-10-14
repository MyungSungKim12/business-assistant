-- TRT-11: service recipes and atomic stock deduction when a linked treatment is completed.
-- Apply after 045. Existing treatments remain unlinked and are never backfilled.
begin;

alter table public.treatment_records
 add column if not exists appointment_service_id uuid;
alter table public.treatment_records
 drop constraint if exists treatment_records_service_scope;
alter table public.treatment_records
 add constraint treatment_records_service_scope
 foreign key (organization_id, appointment_service_id)
 references public.appointment_services(organization_id, id) on delete restrict;
alter table public.treatment_record_events drop constraint if exists treatment_record_events_action_check;
alter table public.treatment_record_events add constraint treatment_record_events_action_check
 -- Keep the prior consultation event action; existing rows must remain valid.
 check (action in ('edit','correct','start','complete','cancel','consult','service_link'));

create table if not exists public.appointment_service_consumables (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 service_id uuid not null,
 product_id uuid not null,
 quantity integer not null check (quantity between 1 and 1000000),
 updated_at timestamptz not null default now(),
 primary key (organization_id, service_id, product_id),
 foreign key (organization_id, service_id) references public.appointment_services(organization_id, id) on delete cascade,
 foreign key (organization_id, product_id) references public.catalog_products(organization_id, id) on delete restrict
);
alter table public.appointment_service_consumables enable row level security;
create policy appointment_service_consumables_select_member on public.appointment_service_consumables
 for select to authenticated using (
  (select private.has_organization_role(organization_id, array['owner','admin','member']::text[]))
 );
revoke all on public.appointment_service_consumables from public, anon, authenticated;
grant select on public.appointment_service_consumables to authenticated;

create or replace function public.set_appointment_service_consumables(
 p_organization_id uuid, p_service_id uuid, p_items jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; product_id uuid; qty integer; result jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id, array['owner','admin']::text[]) then
  raise exception 'Organization manager required' using errcode='42501';
 end if;
 if p_service_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
  raise exception 'Invalid consumable recipe' using errcode='22023';
 end if;
 perform 1 from public.appointment_services where organization_id=p_organization_id and id=p_service_id for update;
 if not found then raise exception 'Appointment service not found' using errcode='P0002'; end if;
 if exists (select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x) <> 'object'
    or (x - array['product_id','quantity']) <> '{}'::jsonb
    or coalesce(x->>'product_id','') !~* '^[0-9a-f-]{36}$'
    or coalesce(x->>'quantity','') !~ '^[1-9][0-9]{0,5}$') then
  raise exception 'Invalid consumable recipe item' using errcode='22023';
 end if;
 if (select count(*) from jsonb_array_elements(p_items)) <>
    (select count(distinct x->>'product_id') from jsonb_array_elements(p_items) x) then
  raise exception 'Duplicate recipe product' using errcode='22023';
 end if;
 for item in select value from jsonb_array_elements(p_items) loop
  product_id=(item->>'product_id')::uuid; qty=(item->>'quantity')::integer;
  perform 1 from public.catalog_products where organization_id=p_organization_id and id=product_id and kind='product' and is_active for share;
  if not found then raise exception 'Active physical product not found' using errcode='22023'; end if;
 end loop;
 delete from public.appointment_service_consumables where organization_id=p_organization_id and service_id=p_service_id;
 insert into public.appointment_service_consumables(organization_id,service_id,product_id,quantity)
  select p_organization_id,p_service_id,(x->>'product_id')::uuid,(x->>'quantity')::integer
  from jsonb_array_elements(p_items) x;
 select coalesce(jsonb_agg(jsonb_build_object('product_id',r.product_id,'quantity',r.quantity) order by r.product_id),'[]'::jsonb)
  into result from public.appointment_service_consumables r where r.organization_id=p_organization_id and r.service_id=p_service_id;
 return result;
end $$;

create or replace function public.set_treatment_service(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_service_id uuid,p_expected_version integer,p_operation_id uuid
) returns setof public.treatment_records language plpgsql security definer set search_path='' as $$
declare t public.treatment_records%rowtype; before_row public.treatment_records%rowtype; s public.appointment_services%rowtype; prior public.treatment_record_events%rowtype; request jsonb; now_at timestamptz;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_operation_id is null then raise exception 'Operation ID required' using errcode='22023'; end if;
 select * into t from public.treatment_records where id=p_treatment_id and organization_id=p_organization_id and customer_id=p_customer_id for update;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 request=jsonb_build_object('actor_id',auth.uid(),'action','service_link','service_id',p_service_id,'expected_version',p_expected_version);
 select * into prior from public.treatment_record_events where treatment_id=p_treatment_id and operation_id=p_operation_id;
 if found then
  if prior.request_data<>request then raise exception 'Operation ID reused with different request' using errcode='P0001'; end if;
  return next t; return;
 end if;
 if p_expected_version is null or t.version<>p_expected_version or t.status not in ('draft','in_progress') then
  raise exception 'Treatment changed or cannot link service' using errcode='P0001'; end if;
 if p_service_id is not null then
  select * into s from public.appointment_services where organization_id=p_organization_id and id=p_service_id and is_active for share;
  if not found then raise exception 'Active appointment service not found' using errcode='22023'; end if;
 end if;
 before_row=t; now_at=clock_timestamp();
 update public.treatment_records set appointment_service_id=p_service_id,version=version+1,updated_at=now_at
  where id=p_treatment_id and organization_id=p_organization_id and customer_id=p_customer_id returning * into t;
 insert into public.treatment_record_events(organization_id,customer_id,treatment_id,actor_id,action,reason,occurred_at,before_data,after_data,operation_id,request_data)
  values(p_organization_id,p_customer_id,p_treatment_id,auth.uid(),'service_link','',now_at,to_jsonb(before_row),to_jsonb(t),p_operation_id,request);
 return next t;
end $$;

create or replace function private.consume_treatment_service_products() returns trigger
 language plpgsql security definer set search_path='' as $$
declare recipe record; product public.catalog_products%rowtype; operation uuid;
begin
 if old.status='completed' or new.status<>'completed' or new.appointment_service_id is null then return new; end if;
 perform 1 from public.appointment_services where organization_id=new.organization_id and id=new.appointment_service_id for share;
 -- Lock every required product in stable order before changing any stock.
 perform p.id from public.catalog_products p join public.appointment_service_consumables r
  on r.organization_id=p.organization_id and r.product_id=p.id
  where r.organization_id=new.organization_id and r.service_id=new.appointment_service_id
  order by p.id for update of p;
 for recipe in select product_id,quantity from public.appointment_service_consumables
  where organization_id=new.organization_id and service_id=new.appointment_service_id order by product_id loop
  select * into product from public.catalog_products where organization_id=new.organization_id and id=recipe.product_id;
  if not found or product.kind<>'product' or not product.is_active then
   raise exception 'Treatment consumable product is unavailable' using errcode='P0001'; end if;
  if product.stock_quantity<recipe.quantity then
   raise exception 'Insufficient product stock' using errcode='P0001'; end if;
  operation=gen_random_uuid();
  update public.catalog_products set stock_quantity=stock_quantity-recipe.quantity,version=version+1
   where organization_id=new.organization_id and id=recipe.product_id;
  insert into public.catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind)
   values(new.organization_id,recipe.product_id,-recipe.quantity,'Treatment completed: '||new.treatment_name,operation,auth.uid(),'treatment_use');
 end loop;
 return new;
end $$;

alter table public.catalog_stock_ledger drop constraint if exists catalog_stock_ledger_movement_check;
alter table public.catalog_stock_ledger add constraint catalog_stock_ledger_movement_check check (
 (movement_kind='receipt' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='sale' and quantity<0 and sale_line_id is not null and operation_id is null)
 or (movement_kind='refund' and quantity>0 and sale_line_id is not null and operation_id is null)
 or (movement_kind='customer_return' and quantity>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind in ('adjustment','supplier_return','disposal','stocktake') and quantity<>0 and sale_line_id is null and operation_id is not null)
 or (movement_kind='treatment_use' and quantity<0 and sale_line_id is null and operation_id is not null)
);
drop trigger if exists treatment_consumables_on_complete on public.treatment_records;
create trigger treatment_consumables_on_complete after update of status on public.treatment_records
 for each row when (new.status='completed' and old.status is distinct from new.status)
 execute function private.consume_treatment_service_products();
revoke all on function private.consume_treatment_service_products() from public,anon,authenticated;
revoke all on function public.set_appointment_service_consumables(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.set_treatment_service(uuid,uuid,uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.set_appointment_service_consumables(uuid,uuid,jsonb),
 public.set_treatment_service(uuid,uuid,uuid,uuid,integer,uuid) to authenticated;
commit;
