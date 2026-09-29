begin;

create table public.customer_photos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    customer_id uuid not null,
    uploaded_by uuid not null references auth.users(id) on delete restrict,
    storage_path text not null unique,
    original_name text not null check (length(btrim(original_name)) between 1 and 255),
    content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
    caption text not null default '' check (length(caption) <= 500),
    is_archived boolean not null default false,
    created_at timestamptz not null default now(),
    constraint customer_photos_customer_scope foreign key (customer_id, organization_id)
        references public.customers(id, organization_id) on delete cascade
);

create index idx_customer_photos_customer_created
    on public.customer_photos (organization_id, customer_id, is_archived, created_at desc);

alter table public.customer_photos enable row level security;
create policy "customer_photos_select_member" on public.customer_photos
    for select to authenticated using (
        (select private.has_organization_role(organization_id, array['owner','admin','member']::text[]))
    );
create policy "customer_photos_insert_manager" on public.customer_photos
    for insert to authenticated with check (
        uploaded_by = (select auth.uid()) and
        (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
    );
create policy "customer_photos_update_manager" on public.customer_photos
    for update to authenticated using (
        (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
    ) with check (
        (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
    );

grant select, insert, update on public.customer_photos to authenticated;

-- The original generic file policy also matched every path under an organization.
-- Narrow it to the two-segment generic-file shape so member uploads cannot target
-- the customer-photo path, which is manager-only below.
drop policy if exists "business_files_select_member" on storage.objects;
drop policy if exists "business_files_insert_member" on storage.objects;
create policy "business_files_select_member" on storage.objects
    for select to authenticated using (
        bucket_id = 'business-files' and
        split_part(name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-' and
        (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin','member']::text[]))
    );
create policy "business_files_insert_member" on storage.objects
    for insert to authenticated with check (
        bucket_id = 'business-files' and
        split_part(name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-' and
        (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin','member']::text[]))
    );

create policy "business_files_customer_photo_select_member" on storage.objects
    for select to authenticated using (
        bucket_id = 'business-files' and
        (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin','member']::text[]))
    );
create policy "business_files_customer_photo_insert_manager" on storage.objects
    for insert to authenticated with check (
        bucket_id = 'business-files' and
        (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin']::text[]))
    );

commit;
