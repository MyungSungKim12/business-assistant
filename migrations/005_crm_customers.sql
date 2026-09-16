begin;

create table public.customers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (length(btrim(name)) > 0),
    email text,
    phone text,
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_customers_organization_id on public.customers (organization_id);

create function private.set_customer_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

revoke all on function private.set_customer_updated_at() from public;

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function private.set_customer_updated_at();

alter table public.customers enable row level security;

create policy "customers_select_member"
on public.customers
for select
to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));

create policy "customers_insert_manager"
on public.customers
for insert
to authenticated
with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

create policy "customers_update_manager"
on public.customers
for update
to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

create policy "customers_delete_manager"
on public.customers
for delete
to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

commit;
