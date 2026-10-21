-- FILE-11: owner/admin managed per-organization storage quota.
begin;

create or replace function public.set_organization_file_storage_quota(p_organization_id uuid,p_quota_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); current_used bigint; reserved bigint; saved_quota bigint;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'File storage quota management required' using errcode='42501'; end if;
 if p_quota_bytes is null or p_quota_bytes<0 or p_quota_bytes>1099511627776 then
  raise exception 'Invalid file storage quota' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file-storage-quota:'||p_organization_id::text,0));
 select quota_bytes into saved_quota from public.organization_file_storage_quotas where organization_id=p_organization_id for update;
 if not found then raise exception 'Storage quota is not configured' using errcode='P0001'; end if;
 current_used=private.organization_file_storage_bytes(p_organization_id);
 select coalesce(sum(size_bytes),0)::bigint into reserved from public.file_storage_upload_reservations where organization_id=p_organization_id and expires_at>now();
 update public.organization_file_storage_quotas set quota_bytes=p_quota_bytes,updated_at=now() where organization_id=p_organization_id;
 insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
 values(p_organization_id,actor,'files.storage_quota_update','organization_file_storage_quota',p_organization_id::text,
  jsonb_build_object('previous_quota_bytes',saved_quota,'quota_bytes',p_quota_bytes,'used_bytes',current_used,'reserved_bytes',reserved),'api_user');
 return jsonb_build_object('organization_id',p_organization_id,'used_bytes',current_used,'reserved_bytes',reserved,'quota_bytes',p_quota_bytes,'available_bytes',greatest(0,p_quota_bytes-current_used-reserved));
end $$;
revoke all on function public.set_organization_file_storage_quota(uuid,bigint) from public,anon,authenticated;
grant execute on function public.set_organization_file_storage_quota(uuid,bigint) to authenticated;

commit;
