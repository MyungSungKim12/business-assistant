-- SEC-STORAGE / CRM-15 / FILE: 059 이후 실행. 원장과 일치하는 활성 객체만 읽기/업로드 허용.
-- 기존 OR 정책을 모두 교체한다. 데이터·Storage 객체는 삭제하지 않는다.
begin;

drop policy if exists customer_photos_select_member on public.customer_photos;
create policy customer_photos_select_member on public.customer_photos for select to authenticated
using (
  (not is_archived and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])))
  or (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
);

-- 휴지통은 관리자에게 메타데이터만 허용한다. 복원 전에는 관리자도 파일을 읽을 수 없다.
drop policy if exists file_assets_select_member on public.file_assets;
create policy file_assets_select_member on public.file_assets for select to authenticated
using (
  (not is_archived and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])))
  or (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
);

-- SECURITY INVOKER: 호출자의 메타데이터 RLS를 그대로 적용한다. 경로의 UUID 형변환이 없어
-- 잘못된 경로도 22P02 대신 거절되며, 기존 storage_path UNIQUE 인덱스로 조회한다.
create or replace function private.can_access_business_object(object_name text, for_upload boolean default false)
returns boolean language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.file_assets f
      where f.storage_path = object_name and not f.is_archived
        and split_part(object_name, '/', 1) = f.organization_id::text
        and cardinality(string_to_array(object_name, '/')) = 2
        and left(split_part(object_name, '/', 2), 37) = f.id::text || '-'
        and private.has_organization_role(f.organization_id, array['owner','admin','member']::text[])
        and (not for_upload or f.uploaded_by = auth.uid())
    ) or exists (
      select 1 from public.customer_photos p
      where p.storage_path = object_name and not p.is_archived
        and split_part(object_name, '/', 1) = p.organization_id::text
        and split_part(object_name, '/', 2) = p.customer_id::text
        and cardinality(string_to_array(object_name, '/')) = 3
        and left(split_part(object_name, '/', 3), 37) = p.id::text || '-'
        and private.has_organization_role(p.organization_id, array['owner','admin','member']::text[])
        and (not for_upload or (p.uploaded_by = auth.uid()
          and private.has_organization_role(p.organization_id, array['owner','admin']::text[])))
    )
  );
$$;
revoke all on function private.can_access_business_object(text, boolean) from public, anon;
grant execute on function private.can_access_business_object(text, boolean) to authenticated;

drop policy if exists business_files_select_member on storage.objects;
drop policy if exists business_files_customer_photo_select_member on storage.objects;
drop policy if exists business_files_insert_member on storage.objects;
drop policy if exists business_files_customer_photo_insert_manager on storage.objects;
create policy business_files_select_member on storage.objects for select to authenticated
using (bucket_id = 'business-files' and private.can_access_business_object(name, false));
create policy business_files_insert_member on storage.objects for insert to authenticated
with check (bucket_id = 'business-files' and private.can_access_business_object(name, true));

-- 비공개 버킷을 유지한다. 기존 서명 URL은 만료 전까지 유효하므로 신규 접근·발급을 제한하는 변경이다.
update storage.buckets set public = false where id = 'business-files';
commit;
