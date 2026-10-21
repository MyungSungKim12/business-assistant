-- TEAM-11 / LAB-10 foundation: effective-dated commission rules. Settlements are calculated in a later stage.
begin;

create table if not exists public.staff_commission_rules (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 staff_id uuid, commission_scope text not null check(commission_scope in ('service','product','membership')),
 service_id uuid, product_id uuid, rate_basis_points integer not null check(rate_basis_points between 0 and 10000),
 basis text not null default 'net_paid' check(basis='net_paid'),
 effective_from date not null, effective_to date,
 version bigint not null default 1 check(version>0), is_active boolean not null default true,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(organization_id,id),
 foreign key(organization_id,staff_id) references public.appointment_staff(organization_id,id) on delete restrict,
 foreign key(organization_id,service_id) references public.appointment_services(organization_id,id) on delete restrict,
 foreign key(organization_id,product_id) references public.catalog_products(organization_id,id) on delete restrict,
 check(effective_to is null or effective_to>=effective_from),
 check((commission_scope='service' and service_id is not null and product_id is null) or
       (commission_scope='product' and product_id is not null and service_id is null) or
       (commission_scope='membership' and product_id is not null and service_id is null))
);
create index if not exists staff_commission_rules_lookup on public.staff_commission_rules(organization_id,staff_id,commission_scope,effective_from desc);
alter table public.staff_commission_rules enable row level security;
drop policy if exists staff_commission_rules_manager_select on public.staff_commission_rules;
create policy staff_commission_rules_manager_select on public.staff_commission_rules for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin']::text[])));
revoke all on public.staff_commission_rules from public,anon,authenticated;
grant select on public.staff_commission_rules to authenticated;

create or replace function private.validate_staff_commission_rule() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.is_active then
  perform pg_advisory_xact_lock(hashtextextended('commission:'||new.organization_id::text||coalesce(new.staff_id::text,'*')||new.commission_scope||coalesce(new.service_id::text,new.product_id::text),0));
  if exists(select 1 from public.staff_commission_rules r where r.organization_id=new.organization_id and r.id<>new.id
   and r.staff_id is not distinct from new.staff_id and r.commission_scope=new.commission_scope
   and r.service_id is not distinct from new.service_id and r.product_id is not distinct from new.product_id
   and daterange(r.effective_from,case when r.effective_to is null then null else r.effective_to+1 end,'[)') &&
       daterange(new.effective_from,case when new.effective_to is null then null else new.effective_to+1 end,'[)')) then
   raise exception 'Commission rule period overlaps' using errcode='23P01';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.validate_staff_commission_rule() from public,anon,authenticated;
drop trigger if exists validate_staff_commission_rule on public.staff_commission_rules;
create trigger validate_staff_commission_rule before insert or update on public.staff_commission_rules
 for each row execute function private.validate_staff_commission_rule();

create or replace function public.list_staff_commission_rules(p_organization_id uuid) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(r) order by r.effective_from desc,r.created_at desc,r.id) from public.staff_commission_rules r where r.organization_id=p_organization_id),'[]'::jsonb);
end $$;

create or replace function public.create_staff_commission_rule(p_organization_id uuid,p_staff_id uuid,p_scope text,p_service_id uuid,p_product_id uuid,p_rate_basis_points integer,p_effective_from date,p_effective_to date default null)
 returns public.staff_commission_rules language plpgsql security definer set search_path='' as $$
declare row public.staff_commission_rules%rowtype;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 if p_scope not in ('service','product','membership') or p_rate_basis_points not between 0 and 10000 or p_effective_from is null or (p_effective_to is not null and p_effective_to<p_effective_from)
  or (p_scope='service' and (p_service_id is null or p_product_id is not null)) or (p_scope in ('product','membership') and (p_product_id is null or p_service_id is not null)) then raise exception 'Invalid commission rule' using errcode='22023'; end if;
 if p_staff_id is not null and not exists(select 1 from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id) then raise exception 'Staff not found' using errcode='P0002'; end if;
 if p_scope='service' and not exists(select 1 from public.appointment_services where organization_id=p_organization_id and id=p_service_id) then raise exception 'Service not found' using errcode='P0002'; end if;
 if p_scope in ('product','membership') and not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=p_product_id and ((p_scope='product' and kind='product') or (p_scope='membership' and kind='membership'))) then raise exception 'Catalog item not found' using errcode='P0002'; end if;
 insert into public.staff_commission_rules(organization_id,staff_id,commission_scope,service_id,product_id,rate_basis_points,effective_from,effective_to,created_by)
 values(p_organization_id,p_staff_id,p_scope,p_service_id,p_product_id,p_rate_basis_points,p_effective_from,p_effective_to,auth.uid()) returning * into row;
 return row;
end $$;

create or replace function public.end_staff_commission_rule(p_organization_id uuid,p_rule_id uuid,p_effective_to date,p_expected_version bigint)
 returns public.staff_commission_rules language plpgsql security definer set search_path='' as $$
declare row public.staff_commission_rules%rowtype;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 select * into row from public.staff_commission_rules where organization_id=p_organization_id and id=p_rule_id for update;
 if not found then raise exception 'Commission rule not found' using errcode='P0002'; end if;
 if row.version<>p_expected_version or not row.is_active or p_effective_to<row.effective_from or (row.effective_to is not null and p_effective_to>row.effective_to) then raise exception 'Commission rule conflict' using errcode='P0001'; end if;
 update public.staff_commission_rules set effective_to=p_effective_to,is_active=false,version=version+1 where organization_id=p_organization_id and id=p_rule_id returning * into row;
 return row;
end $$;
revoke all on function public.list_staff_commission_rules(uuid),public.create_staff_commission_rule(uuid,uuid,text,uuid,uuid,integer,date,date),public.end_staff_commission_rule(uuid,uuid,date,bigint) from public,anon,authenticated;
grant execute on function public.list_staff_commission_rules(uuid),public.create_staff_commission_rule(uuid,uuid,text,uuid,uuid,integer,date,date),public.end_staff_commission_rule(uuid,uuid,date,bigint) to authenticated;

commit;
