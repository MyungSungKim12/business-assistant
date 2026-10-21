-- 096: FILE-11 요금제 저장 용량 상한. 숫자는 플랫폼 관리자가 결정·설정하며 기본값을 임의로 넣지 않는다.
-- 조직별 요청 한도는 계속 저장하고, 업로드 시 활성 요금제 상한과 작은 값을 적용한다.
begin;

alter table public.plans
 add column if not exists file_storage_quota_bytes bigint
 check (file_storage_quota_bytes between 0 and 1099511627776);

create or replace function private.organization_file_storage_plan_quota(p_organization_id uuid)
returns bigint language sql stable security definer set search_path='' as $$
 select p.file_storage_quota_bytes
 from public.subscriptions s
 join public.plans p on p.id=s.plan_id
 where s.organization_id=p_organization_id
  and s.status in ('trialing','active')
  and s.starts_at<=now()
  and (s.ends_at is null or s.ends_at>now())
 order by s.starts_at desc,s.id desc
 limit 1
$$;
revoke all on function private.organization_file_storage_plan_quota(uuid) from public,anon,authenticated;

create or replace function private.file_storage_usage_snapshot(p_organization_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 with organization_quota as (
  select quota_bytes from public.organization_file_storage_quotas where organization_id=p_organization_id
 ), plan_quota as (
  select private.organization_file_storage_plan_quota(p_organization_id) as quota_bytes
 ), used as (
  select private.organization_file_storage_bytes(p_organization_id) as bytes
 ), held as (
  select coalesce(sum(size_bytes),0)::bigint as bytes from public.file_storage_upload_reservations
  where organization_id=p_organization_id and expires_at>now()
 )
 select jsonb_build_object(
  'organization_id',p_organization_id,
  'used_bytes',used.bytes,
  'reserved_bytes',held.bytes,
  'organization_quota_bytes',organization_quota.quota_bytes,
  'plan_quota_bytes',plan_quota.quota_bytes,
  'quota_bytes',case when plan_quota.quota_bytes is null then organization_quota.quota_bytes else least(organization_quota.quota_bytes,plan_quota.quota_bytes) end,
  'available_bytes',greatest(0,(case when plan_quota.quota_bytes is null then organization_quota.quota_bytes else least(organization_quota.quota_bytes,plan_quota.quota_bytes) end)-used.bytes-held.bytes)
 )
 from organization_quota,plan_quota,used,held
$$;
revoke all on function private.file_storage_usage_snapshot(uuid) from public,anon,authenticated;

create or replace function public.reserve_file_storage_upload(p_organization_id uuid,p_operation_id uuid,p_storage_path text,p_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); prior public.file_storage_upload_reservations%rowtype; usage jsonb; limit_bytes bigint; used_bytes bigint; held_bytes bigint;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'File upload access required' using errcode='42501'; end if;
 if p_operation_id is null or p_storage_path is null or split_part(p_storage_path,'/',1)<>p_organization_id::text or split_part(p_storage_path,'/',2)='' or position('..' in p_storage_path)>0
  or p_size_bytes is null or p_size_bytes<0 or p_size_bytes>52428800 then raise exception 'Invalid upload reservation' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file-storage-quota:'||p_organization_id::text,0));
 perform 1 from public.subscriptions s join public.plans p on p.id=s.plan_id
  where s.organization_id=p_organization_id and s.status in ('trialing','active') and s.starts_at<=now()
   and (s.ends_at is null or s.ends_at>now()) for share of p;
 select * into prior from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.uploaded_by<>actor or prior.storage_path<>p_storage_path or prior.size_bytes<>p_size_bytes then raise exception 'Upload reservation conflict' using errcode='P0001'; end if;
  if prior.expires_at>now() then return private.file_storage_usage_snapshot(p_organization_id); end if;
  delete from public.file_storage_upload_reservations where organization_id=p_organization_id and operation_id=p_operation_id;
 end if;
 usage=private.file_storage_usage_snapshot(p_organization_id);
 limit_bytes=(usage->>'quota_bytes')::bigint;
 used_bytes=(usage->>'used_bytes')::bigint;
 held_bytes=(usage->>'reserved_bytes')::bigint;
 if limit_bytes is null then raise exception 'Storage quota is not configured' using errcode='P0001'; end if;
 if used_bytes+held_bytes+p_size_bytes>limit_bytes then raise exception 'Organization file storage quota exceeded' using errcode='22023'; end if;
 insert into public.file_storage_upload_reservations(organization_id,operation_id,storage_path,size_bytes,uploaded_by,expires_at)
 values(p_organization_id,p_operation_id,p_storage_path,p_size_bytes,actor,now()+interval '30 minutes');
 return private.file_storage_usage_snapshot(p_organization_id);
end $$;
revoke all on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.reserve_file_storage_upload(uuid,uuid,text,bigint) to authenticated;

create or replace function public.set_organization_file_storage_quota(p_organization_id uuid,p_quota_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); saved_quota bigint; current_usage jsonb;
begin
 if actor is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'File storage quota management required' using errcode='42501'; end if;
 if p_quota_bytes is null or p_quota_bytes<0 or p_quota_bytes>1099511627776 then
  raise exception 'Invalid file storage quota' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file-storage-quota:'||p_organization_id::text,0));
 select quota_bytes into saved_quota from public.organization_file_storage_quotas where organization_id=p_organization_id for update;
 if not found then raise exception 'Storage quota is not configured' using errcode='P0001'; end if;
 current_usage=private.file_storage_usage_snapshot(p_organization_id);
 update public.organization_file_storage_quotas set quota_bytes=p_quota_bytes,updated_at=now() where organization_id=p_organization_id;
 insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata,source)
 values(p_organization_id,actor,'files.storage_quota_update','organization_file_storage_quota',p_organization_id::text,
  jsonb_build_object('previous_quota_bytes',saved_quota,'organization_quota_bytes',p_quota_bytes,'effective_quota_bytes',case when current_usage->>'plan_quota_bytes' is null then p_quota_bytes else least(p_quota_bytes,(current_usage->>'plan_quota_bytes')::bigint) end,'used_bytes',(current_usage->>'used_bytes')::bigint,'reserved_bytes',(current_usage->>'reserved_bytes')::bigint),'api_user');
 return private.file_storage_usage_snapshot(p_organization_id);
end $$;
revoke all on function public.set_organization_file_storage_quota(uuid,bigint) from public,anon,authenticated;
grant execute on function public.set_organization_file_storage_quota(uuid,bigint) to authenticated;

-- 구독 변경과 파일 예약을 조직별 한 락으로 직렬화해 요금제 전환 중 구 상한으로 예약하지 못하게 한다.
create or replace function public.replace_organization_subscription(target_organization_id uuid, target_plan_code text, target_status text, target_starts_at timestamptz, target_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare selected_plan_id uuid;
begin
 if not exists(select 1 from public.organizations where id=target_organization_id) then raise exception 'organization not found'; end if;
 if target_ends_at is not null and target_ends_at<=target_starts_at then raise exception 'invalid subscription window'; end if;
 if target_starts_at is null or target_status not in ('trialing','active','past_due','canceled','expired') then raise exception 'unsupported subscription input'; end if;
 select id into selected_plan_id from public.plans where code=upper(trim(target_plan_code)) and is_active;
 if selected_plan_id is null then raise exception 'unknown plan code'; end if;
 perform pg_advisory_xact_lock(hashtextextended('file-storage-quota:'||target_organization_id::text,0));
 delete from public.subscriptions where organization_id=target_organization_id and status in ('trialing','active');
 insert into public.subscriptions(organization_id,plan_id,status,starts_at,ends_at)
 values(target_organization_id,selected_plan_id,target_status,target_starts_at,target_ends_at);
 return jsonb_build_object('organization_id',target_organization_id,'plan_code',upper(trim(target_plan_code)));
end $$;
revoke all on function public.replace_organization_subscription(uuid,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.replace_organization_subscription(uuid,text,text,timestamptz,timestamptz) to service_role;

commit;
