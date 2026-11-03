-- R1030-07 / CRM 사진: 099 이후. 기존 사진은 유지하고 신규 전송만 pending으로 시작한다.
-- Storage 객체는 삭제하지 않는다. 만료된 미완료 메타데이터는 목록 조회 때 정리한다.
begin;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_photos' and column_name='upload_state') then
  alter table public.customer_photos add column upload_state text not null default 'ready';
  -- Existing valid photos stay ready. Legacy orphan metadata is quarantined, never deleted.
  update public.customer_photos p set upload_state='pending' where not p.is_archived and not exists(
   select 1 from storage.objects o where o.bucket_id='business-files' and o.name=p.storage_path
    and case when (o.metadata->>'size')~'^[0-9]+$' then (o.metadata->>'size')::bigint end=p.size_bytes
    and o.metadata->>'mimetype'=p.content_type
  );
 end if;
end $$;
alter table public.customer_photos alter column upload_state set default 'pending';
alter table public.customer_photos add column if not exists uploaded_at timestamptz;
alter table public.customer_photos drop constraint if exists customer_photos_upload_state_check;
alter table public.customer_photos add constraint customer_photos_upload_state_check check(upload_state in ('pending','ready','failed'));
create index if not exists idx_customer_photos_pending on public.customer_photos(organization_id,customer_id,created_at) where upload_state='pending' and not is_archived;

create or replace function private.guard_customer_photo_upload()
returns trigger language plpgsql security definer set search_path='' as $$
declare actual_size bigint; actual_type text;
begin
 if tg_op='INSERT' then
  new.upload_state:='pending'; new.uploaded_at:=null;
 elsif old.upload_state='pending' and new.is_archived then
  new.upload_state:='failed'; new.archived_reason:='upload_failed'; new.uploaded_at:=null;
 elsif old.upload_state='pending' and new.upload_state='ready' then
  select case when (metadata->>'size')~'^[0-9]+$' then (metadata->>'size')::bigint end,metadata->>'mimetype'
   into actual_size,actual_type from storage.objects where bucket_id='business-files' and name=new.storage_path;
  if actual_size is distinct from new.size_bytes or actual_type is distinct from new.content_type then
   raise exception 'Photo upload is missing or does not match its metadata' using errcode='22023';
  end if;
  new.uploaded_at:=now();
 elsif new.upload_state is distinct from old.upload_state then
  raise exception 'Invalid photo upload transition' using errcode='22023';
 else new.uploaded_at:=old.uploaded_at;
 end if;
 return new;
end $$;
revoke all on function private.guard_customer_photo_upload() from public,anon,authenticated;
drop trigger if exists customer_photos_upload_guard on public.customer_photos;
create trigger customer_photos_upload_guard before insert or update on public.customer_photos for each row execute function private.guard_customer_photo_upload();

create or replace function public.complete_customer_photo_upload(p_organization_id uuid,p_customer_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo public.customer_photos%rowtype;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Photo manager required' using errcode='42501'; end if;
 select * into photo from public.customer_photos where organization_id=p_organization_id and customer_id=p_customer_id and id=p_photo_id and not is_archived for update;
 if not found or photo.upload_state='failed' then raise exception 'Photo not found' using errcode='P0002'; end if;
 if photo.upload_state='pending' then
  update public.customer_photos set upload_state='ready' where id=photo.id returning * into photo;
 end if;
 return to_jsonb(photo);
end $$;
revoke all on function public.complete_customer_photo_upload(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_customer_photo_upload(uuid,uuid,uuid) to authenticated;

-- A completed PUT followed by a crashed client is recovered without another upload.
-- Missing/mismatched objects stay hidden, then fail after the signed URL's 2h validity + grace.
create or replace function public.reconcile_customer_photo_uploads(p_organization_id uuid,p_customer_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare photo public.customer_photos%rowtype; actual_size bigint; actual_type text; processed integer:=0;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then raise exception 'Photo access required' using errcode='42501'; end if;
 for photo in select * from public.customer_photos where organization_id=p_organization_id and customer_id=p_customer_id and upload_state='pending' and not is_archived order by created_at,id limit 250 for update skip locked loop
  actual_size:=null; actual_type:=null;
  select case when (metadata->>'size')~'^[0-9]+$' then (metadata->>'size')::bigint end,metadata->>'mimetype'
   into actual_size,actual_type from storage.objects where bucket_id='business-files' and name=photo.storage_path;
  if actual_size=photo.size_bytes and actual_type=photo.content_type then
   update public.customer_photos set upload_state='ready' where id=photo.id;
   processed:=processed+1;
  elsif photo.created_at<now()-interval '130 minutes' then
   update public.customer_photos set is_archived=true,archived_reason='upload_failed' where id=photo.id;
   processed:=processed+1;
  end if;
 end loop;
 return processed;
end $$;
revoke all on function public.reconcile_customer_photo_uploads(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reconcile_customer_photo_uploads(uuid,uuid) to authenticated;
commit;
