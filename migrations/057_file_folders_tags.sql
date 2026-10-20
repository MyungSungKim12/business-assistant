-- FILE-11: metadata only. Storage object paths are intentionally unchanged.
begin;
create table if not exists public.file_folders (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 80),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index if not exists file_folders_name_ci on public.file_folders(organization_id,lower(btrim(name)));
alter table public.file_assets add column if not exists folder_id uuid;
alter table public.file_assets add column if not exists tags text[] not null default '{}';
alter table public.file_assets drop constraint if exists file_assets_tags_limit;
alter table public.file_assets add constraint file_assets_tags_limit check(cardinality(tags)<=10 and array_position(tags,'') is null) not valid;
alter table public.file_assets validate constraint file_assets_tags_limit;
alter table public.file_assets drop constraint if exists file_assets_folder_scope;
alter table public.file_assets add constraint file_assets_folder_scope foreign key(folder_id,organization_id)
 references public.file_folders(id,organization_id) on delete set null (folder_id);
create index if not exists file_assets_folder_created on public.file_assets(organization_id,folder_id,created_at desc);
create index if not exists file_assets_tags_gin on public.file_assets using gin(tags);
alter table public.file_folders enable row level security;
drop policy if exists file_folders_member_select on public.file_folders;
create policy file_folders_member_select on public.file_folders for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists file_folders_manager_insert on public.file_folders;
create policy file_folders_manager_insert on public.file_folders for insert to authenticated
 with check(created_by=(select auth.uid()) and (select private.has_organization_role(organization_id,array['owner','admin']::text[])));
drop policy if exists file_folders_manager_update on public.file_folders;
create policy file_folders_manager_update on public.file_folders for update to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin']::text[])))
 with check((select private.has_organization_role(organization_id,array['owner','admin']::text[])));
drop policy if exists file_folders_manager_delete on public.file_folders;
create policy file_folders_manager_delete on public.file_folders for delete to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin']::text[])));
grant select,insert,update,delete on public.file_folders to authenticated;
commit;
