begin;

insert into public.features (code, name, description)
values ('files.basic', '파일·자료 관리', '조직 파일 업로드와 공유 기능')
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into public.plan_features (plan_id, feature_code)
select plans.id, 'files.basic'
from public.plans
where plans.code in ('BASIC', 'STANDARD', 'PRO')
on conflict (plan_id, feature_code) do nothing;

create table public.file_assets (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    uploaded_by uuid not null references auth.users(id) on delete restrict,
    storage_path text not null unique,
    original_name text not null check (length(btrim(original_name)) between 1 and 255),
    content_type text not null check (length(btrim(content_type)) between 1 and 255),
    size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 52428800),
    is_archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_file_assets_org_archived_created
on public.file_assets (organization_id, is_archived, created_at desc);

create function private.set_file_asset_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
revoke all on function private.set_file_asset_updated_at() from public;
create trigger file_assets_set_updated_at before update on public.file_assets
for each row execute function private.set_file_asset_updated_at();

alter table public.file_assets enable row level security;
create policy "file_assets_select_member" on public.file_assets for select to authenticated
using ((select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
create policy "file_assets_insert_member" on public.file_assets for insert to authenticated
with check (uploaded_by = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
create policy "file_assets_update_manager" on public.file_assets for update to authenticated
using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])))
with check ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));

insert into storage.buckets (id, name, public)
values ('business-files', 'business-files', false)
on conflict (id) do update set public = false;

create policy "business_files_select_member" on storage.objects for select to authenticated
using (bucket_id = 'business-files' and split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin','member']::text[])));
create policy "business_files_insert_member" on storage.objects for insert to authenticated
with check (bucket_id = 'business-files' and split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and (select private.has_organization_role(split_part(name, '/', 1)::uuid, array['owner','admin','member']::text[])));

commit;
