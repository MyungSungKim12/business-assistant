begin;

create table public.customer_activities (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    customer_id uuid not null references public.customers(id) on delete cascade,
    activity_type text not null default 'note' check (length(btrim(activity_type)) > 0),
    title text not null check (length(btrim(title)) > 0),
    description text not null default '',
    occurred_at timestamptz not null default now(),
    created_by uuid not null default auth.uid() references auth.users(id),
    created_at timestamptz not null default now(),
    constraint customer_activities_same_organization foreign key (customer_id, organization_id)
        references public.customers (id, organization_id) on delete cascade
);

create unique index idx_customers_id_organization on public.customers (id, organization_id);
create index idx_customer_activities_customer_occurred
    on public.customer_activities (organization_id, customer_id, occurred_at desc);

alter table public.customer_activities enable row level security;

create policy "customer_activities_select_member" on public.customer_activities
for select to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "customer_activities_insert_member" on public.customer_activities
for insert to authenticated with check ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])) and created_by = (select auth.uid()));
create policy "customer_activities_delete_manager" on public.customer_activities
for delete to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

grant select, insert, delete on public.customer_activities to authenticated;
commit;
