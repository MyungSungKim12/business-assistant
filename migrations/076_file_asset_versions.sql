-- FILE-11: append-only history for organization files; current file_assets remains the active snapshot.
begin;

alter table public.file_assets add column if not exists version_number integer not null default 1 check(version_number>0);

create table if not exists public.file_asset_versions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 file_id uuid not null references public.file_assets(id) on delete cascade,
 version_number integer not null check(version_number>0),
 storage_path text not null unique,
 operation_id uuid,
 request_fingerprint text,
 result_snapshot jsonb,
 original_name text not null check(length(btrim(original_name)) between 1 and 255),
 content_type text not null check(length(btrim(content_type)) between 1 and 255),
 size_bytes bigint not null check(size_bytes between 0 and 52428800),
 uploaded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(organization_id,file_id,version_number)
);
create index if not exists file_asset_versions_history on public.file_asset_versions(organization_id,file_id,version_number desc);
create unique index if not exists file_asset_versions_operation on public.file_asset_versions(organization_id,operation_id) where operation_id is not null;
alter table public.file_asset_versions enable row level security;
drop policy if exists file_asset_versions_member_select on public.file_asset_versions;
create policy file_asset_versions_member_select on public.file_asset_versions for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.file_asset_versions from public,anon,authenticated;
grant select on public.file_asset_versions to authenticated;
drop trigger if exists immutable on public.file_asset_versions;
create trigger immutable before update or delete on public.file_asset_versions
 for each row execute function private.prevent_catalog_ledger_change();

insert into public.file_asset_versions(organization_id,file_id,version_number,storage_path,original_name,content_type,size_bytes,uploaded_by,created_at)
select organization_id,id,1,storage_path,original_name,content_type,size_bytes,uploaded_by,created_at from public.file_assets
on conflict(organization_id,file_id,version_number) do nothing;

create or replace function private.capture_initial_file_asset_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.file_asset_versions(organization_id,file_id,version_number,storage_path,original_name,content_type,size_bytes,uploaded_by)
 values(new.organization_id,new.id,1,new.storage_path,new.original_name,new.content_type,new.size_bytes,new.uploaded_by)
 on conflict(organization_id,file_id,version_number) do nothing;
 return new;
end $$;
revoke all on function private.capture_initial_file_asset_version() from public,anon,authenticated;
drop trigger if exists file_assets_capture_initial_version on public.file_assets;
create trigger file_assets_capture_initial_version after insert on public.file_assets
 for each row execute function private.capture_initial_file_asset_version();

create or replace function public.create_file_asset_version(
 p_organization_id uuid,p_file_id uuid,p_expected_version integer,p_operation_id uuid,p_storage_path text,
 p_original_name text,p_content_type text,p_size_bytes bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare asset public.file_assets%rowtype; actor uuid; prior public.file_asset_versions%rowtype; fp text;
begin
 actor:=auth.uid();
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'File access required' using errcode='42501'; end if;
 if p_expected_version is null or p_expected_version<1 or p_operation_id is null or p_storage_path is null or p_storage_path!~('^'||p_organization_id::text||'/'||p_operation_id::text||'-[A-Za-z0-9._-]+$')
  or p_original_name is null or length(btrim(p_original_name)) not between 1 and 255
  or p_content_type is null or length(btrim(p_content_type)) not between 1 and 255
  or p_size_bytes is null or p_size_bytes<0 or p_size_bytes>52428800 then
  raise exception 'Invalid file version' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('file',p_file_id,'version',p_expected_version,'path',p_storage_path,'name',btrim(p_original_name),'type',btrim(p_content_type),'size',p_size_bytes)::text);
 perform pg_advisory_xact_lock(hashtextextended('file-version:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.file_asset_versions where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.file_id<>p_file_id or prior.uploaded_by<>actor or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into asset from public.file_assets where organization_id=p_organization_id and id=p_file_id for update;
 if not found or asset.is_archived then raise exception 'File not found' using errcode='P0002'; end if;
 if asset.version_number<>p_expected_version then raise exception 'File version changed' using errcode='P0001'; end if;
 update public.file_assets set storage_path=p_storage_path,original_name=btrim(p_original_name),content_type=btrim(p_content_type),size_bytes=p_size_bytes,
  uploaded_by=actor,version_number=version_number+1 where id=p_file_id returning * into asset;
 insert into public.file_asset_versions(organization_id,file_id,version_number,storage_path,operation_id,request_fingerprint,result_snapshot,original_name,content_type,size_bytes,uploaded_by)
 values(p_organization_id,p_file_id,asset.version_number,p_storage_path,p_operation_id,fp,to_jsonb(asset),btrim(p_original_name),btrim(p_content_type),p_size_bytes,actor);
 return to_jsonb(asset);
end $$;
revoke all on function public.create_file_asset_version(uuid,uuid,integer,uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.create_file_asset_version(uuid,uuid,integer,uuid,text,text,text,bigint) to authenticated;

commit;
