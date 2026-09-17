begin;

alter table public.customers
    add column if not exists birth_date date,
    add column if not exists skin_type text,
    add column if not exists concerns text[] not null default '{}'::text[],
    add column if not exists allergies text not null default '',
    add column if not exists last_visit_date date,
    add column if not exists next_visit_date date,
    add column if not exists tags text[] not null default '{}'::text[],
    add column if not exists status text not null default 'active';

alter table public.customers
    drop constraint if exists customers_status_check;
alter table public.customers
    add constraint customers_status_check check (status in ('active', 'inactive', 'vip', 'blocked'));

create index if not exists idx_customers_organization_status
    on public.customers (organization_id, status, updated_at desc);
create index if not exists idx_customers_tags on public.customers using gin (tags);
create index if not exists idx_customers_next_visit on public.customers (organization_id, next_visit_date)
    where next_visit_date is not null;

create unique index if not exists idx_customers_id_organization
    on public.customers (id, organization_id);

create table public.treatment_records (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    customer_id uuid not null,
    treatment_date date not null default current_date,
    treatment_name text not null check (length(btrim(treatment_name)) > 0),
    category text not null default '',
    practitioner text not null default '',
    notes text not null default '',
    amount numeric(14, 2) check (amount is null or amount >= 0),
    next_visit_date date,
    created_by uuid not null default auth.uid() references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint treatment_records_same_organization foreign key (customer_id, organization_id)
        references public.customers (id, organization_id) on delete cascade
);

create index idx_treatment_records_customer_date
    on public.treatment_records (organization_id, customer_id, treatment_date desc);
create index idx_treatment_records_category
    on public.treatment_records (organization_id, category, treatment_date desc);

create unique index if not exists idx_treatment_records_id_customer
    on public.treatment_records (id, customer_id);

create table public.treatment_photos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    customer_id uuid not null,
    treatment_id uuid not null references public.treatment_records(id) on delete cascade,
    storage_path text not null check (length(btrim(storage_path)) > 0),
    thumbnail_path text,
    content_type text not null default 'image/jpeg',
    caption text not null default '',
    sort_order integer not null default 0 check (sort_order >= 0),
    taken_at timestamptz,
    created_by uuid not null default auth.uid() references auth.users(id),
    created_at timestamptz not null default now(),
    constraint treatment_photos_same_organization foreign key (customer_id, organization_id)
        references public.customers (id, organization_id) on delete cascade,
    constraint treatment_photos_treatment_customer foreign key (treatment_id, customer_id)
        references public.treatment_records (id, customer_id) on delete cascade
);

create index idx_treatment_photos_treatment_sort
    on public.treatment_photos (organization_id, treatment_id, sort_order, created_at);
create index idx_treatment_photos_customer_created
    on public.treatment_photos (organization_id, customer_id, created_at desc);

alter table public.treatment_records enable row level security;
alter table public.treatment_photos enable row level security;

create policy "treatment_records_select_member" on public.treatment_records
for select to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "treatment_records_insert_manager" on public.treatment_records
for insert to authenticated with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])) and created_by = (select auth.uid()));
create policy "treatment_records_update_manager" on public.treatment_records
for update to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));
create policy "treatment_records_delete_manager" on public.treatment_records
for delete to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

create policy "treatment_photos_select_member" on public.treatment_photos
for select to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "treatment_photos_insert_manager" on public.treatment_photos
for insert to authenticated with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])) and created_by = (select auth.uid()));
create policy "treatment_photos_update_manager" on public.treatment_photos
for update to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));
create policy "treatment_photos_delete_manager" on public.treatment_photos
for delete to authenticated using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

grant select, insert, update, delete on public.treatment_records to authenticated;
grant select, insert, update, delete on public.treatment_photos to authenticated;

commit;
