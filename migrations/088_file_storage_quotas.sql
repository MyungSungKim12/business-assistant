-- FILE-11: per-organization quota accounting over actual bucket objects and active upload reservations.
begin;

create table if not exists public.organization_file_storage_quotas(
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 quota_bytes bigint not null default 5368709120 check(quota_bytes between 0 and 1099511627776),
 updated_at timestamptz not null default now()
);
insert into public.organization_file_storage_quotas(organization_id)
select id from public.organizations on conflict(organization_id) do nothing;
create or replace function private.initialize_file_storage_quota()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.organization_file_storage_quotas(organization_id) values(new.id) on conflict(organization_id) do nothing;
 return new;
end $$;
revoke all on function private.initialize_file_storage_quota() from public,anon,authenticated;
drop trigger if exists organizations_initialize_file_storage_quota on public.organizations;
create trigger organizations_initialize_file_storage_quota after insert on public.organizations
 for each row execute function private.initialize_file_storage_quota();
alter table public.organization_file_storage_quotas enable row level security;
drop policy if exists organization_file_storage_quota_member_read on public.organization_file_storage_quotas;
create policy organization_file_storage_quota_member_read on public.organization_file_storage_quotas for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.organization_file_storage_quotas from public,anon,authenticated;
grant select on public.organization_file_storage_quotas to authenticated;

create table if not exists public.file_storage_upload_reservations(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 operation_id uuid not null,storage_path text not null unique,
 size_bytes bigint not null check(size_bytes between 0 and 52428800),
 uploaded_by uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null,created_at timestamptz not null default now(),
 primary key(organization_id,operation_id)
);
create index if not exists file_storage_upload_reservations_expiry on public.file_storage_upload_reservations(expires_at);
alter table public.file_storage_upload_reservations enable row level security;
revoke all on public.file_storage_upload_reservations from public,anon,authenticated;

create or replace function private.organization_file_storage_bytes(p_organization_id uuid)
returns bigint language sql stable security definer set search_path='' as $$
 select coalesce(sum(case when (o.metadata->>'size')~'^[0-9]+$' then (o.metadata->>'size')::bigint else 0 end),0)::bigint
 from storage.objects o where o.bucket_id='business-files' and split_part(o.name,'/',1)=p_organization_id::text
$$;
revoke all on function private.organization_file_storage_bytes(uuid) from public,anon,authenticated;

create or replace function private.file_storage_usage_snapshot(p_organization_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 with limits as(select quota_bytes from public.organization_file_storage_quotas where organization_id=p_organization_id),
 used as(select private.organization_file_storage_bytes(p_organization_id) bytes),
 held as(select coalesce(sum(size_bytes),0)::bigint bytes from public.file_storage_upload_reservations where organization_id=p_organization_id and expires_at>now())
 select jsonb_build_object('organization_id',p_organization_id,'used_bytes',used.bytes,'reserved_bytes',held.bytes,
  'quota_bytes',limits.quota_bytes,'available_bytes',greatest(0,limits.quota_bytes-used.bytes-held.bytes))
 from limits,used,held
$$;
revoke all on function private.file_storage_usage_snapshot(uuid) from public,anon,authenticated;

create or replace function public.get_file_storage_usage(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'File storage access required' using errcode='42501'; end if;
 return private.file_storage_usage_snapshot(p_organization_id);
end $$;
revoke all on function public.get_file_storage_usage(uuid) from public,anon,authenticated;
grant execute on function public.get_file_storage_usage(uuid) to authenticated;

create or replace function public.reserve_file_storage_upload(p_organization_id uuid,p_operation_id uuid,p_storage_path text,p_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); prior public.file_storage_upload_reservations%rowtype; usage jsonb; limit_bytes bigint; used_bytes bigint; held_bytes bigint;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'File upload access required' using errcode='42501'; end if;
 if p_operation_id is null or p_storage_path is null or split_part(p_storage_path,'/',1)<>p_organization_id::text or split_part(p_storage_path,'/',2)='' or position('..' in p_storage_path)>0
  or p_size_bytes is null or p_size_bytes<0 or p_size_bytes>52428800 then raise exception 'Invalid upload reservation' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file-storage-quota:'||p_organization_id::text,0));
 select * into prior from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.uploaded_by<>actor or prior.storage_path<>p_storage_path or prior.size_bytes<>p_size_bytes then raise exception 'Upload reservation conflict' using errcode='P0001'; end if;
  if prior.expires_at>now() then return private.file_storage_usage_snapshot(p_organization_id); end if;
  delete from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id;
 end if;
 select quota_bytes into limit_bytes from public.organization_file_storage_quotas where organization_id=p_organization_id;
 if not found then raise exception 'Storage quota is not configured' using errcode='P0001'; end if;
 used_bytes=private.organization_file_storage_bytes(p_organization_id);
 select coalesce(sum(size_bytes),0)::bigint into held_bytes from public.file_storage_upload_reservations where organization_id=p_organization_id and expires_at>now();
 if used_bytes+held_bytes+p_size_bytes>limit_bytes then raise exception 'Organization file storage quota exceeded' using errcode='22023'; end if;
 insert into public.file_storage_upload_reservations(organization_id,operation_id,storage_path,size_bytes,uploaded_by,expires_at)
 values(p_organization_id,p_operation_id,p_storage_path,p_size_bytes,actor,now()+interval '30 minutes');
 usage=private.file_storage_usage_snapshot(p_organization_id);return usage;
end $$;
revoke all on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) to authenticated;

create or replace function public.release_file_storage_upload(p_organization_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); reservation public.file_storage_upload_reservations%rowtype;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'File access required' using errcode='42501'; end if;
 delete from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id and (uploaded_by=actor or private.has_organization_role(p_organization_id,array['owner','admin']::text[])) returning * into reservation;
 return jsonb_build_object('released',found);
end $$;
revoke all on function public.release_file_storage_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_file_storage_upload(uuid,uuid) to authenticated;

create or replace function public.complete_file_upload(p_organization_id uuid,p_file_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); asset public.file_assets%rowtype; actual_size bigint; held public.file_storage_upload_reservations%rowtype;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'File access required' using errcode='42501'; end if;
 select * into asset from public.file_assets where organization_id=p_organization_id and id=p_file_id and not is_archived;
 if not found or (asset.uploaded_by<>actor and not private.has_organization_role(p_organization_id,array['owner','admin']::text[])) then raise exception 'File not found' using errcode='P0002'; end if;
 select case when (metadata->>'size')~'^[0-9]+$' then (metadata->>'size')::bigint else null end into actual_size from storage.objects where bucket_id='business-files' and name=asset.storage_path;
 if actual_size is null or actual_size<>asset.size_bytes then raise exception 'Uploaded file size does not match its reservation' using errcode='22023'; end if;
 delete from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id and storage_path=asset.storage_path and size_bytes=actual_size and (uploaded_by=actor or private.has_organization_role(p_organization_id,array['owner','admin']::text[])) returning * into held;
 if not found and not exists(select 1 from public.file_asset_versions v where v.organization_id=p_organization_id and v.file_id=p_file_id and v.version_number=1 and v.size_bytes=actual_size) then raise exception 'Upload reservation not found' using errcode='P0002'; end if;
 return to_jsonb(asset);
end $$;
revoke all on function public.complete_file_upload(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_file_upload(uuid,uuid,uuid) to authenticated;

create or replace function private.consume_file_version_upload_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
declare held public.file_storage_upload_reservations%rowtype; actual_size bigint;
begin
 if new.operation_id is null then return new; end if;
 select * into held from public.file_storage_upload_reservations where organization_id=new.organization_id and operation_id=new.operation_id for update;
 if not found or held.storage_path<>new.storage_path or held.size_bytes<>new.size_bytes or held.uploaded_by<>new.uploaded_by then raise exception 'File version upload reservation mismatch' using errcode='P0001'; end if;
 select case when (metadata->>'size')~'^[0-9]+$' then (metadata->>'size')::bigint else null end into actual_size from storage.objects where bucket_id='business-files' and name=new.storage_path;
 if actual_size is null or actual_size<>new.size_bytes then raise exception 'Uploaded file size does not match its reservation' using errcode='22023'; end if;
 delete from public.file_storage_upload_reservations where organization_id=new.organization_id and operation_id=new.operation_id;
 return new;
end $$;
revoke all on function private.consume_file_version_upload_reservation() from public,anon,authenticated;
drop trigger if exists file_asset_versions_consume_upload_reservation on public.file_asset_versions;
create trigger file_asset_versions_consume_upload_reservation before insert on public.file_asset_versions
 for each row execute function private.consume_file_version_upload_reservation();

commit;
