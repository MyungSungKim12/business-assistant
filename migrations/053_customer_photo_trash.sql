-- 053: CRM-15 고객 사진 휴지통(삭제한 사진 복원).
-- 고객 사진 삭제는 원래 is_archived=true로 목록에서만 숨기는 방식이다. 이 마이그레이션은 삭제한 시각·사람·사유를 DB가 직접 기록해
-- 관리자가 "휴지통"에서 삭제한 사진을 확인하고 복원할 수 있게 한다. 저장소 파일은 지우지 않는다(영구 삭제·보관 기간은 정책 결정 후).
-- nullable/기본값 컬럼과 함수·트리거·인덱스 추가뿐이라 기존 행을 바꾸지 않고 여러 번 실행해도 안전하다.
-- 049(private.person_name) 이후에 적용한다. 적용 후 API 서버를 재시작한다.
begin;

alter table public.customer_photos add column if not exists archived_at timestamptz;
alter table public.customer_photos add column if not exists archived_by uuid references auth.users(id) on delete set null;
-- 삭제한 사람의 이름은 삭제 시점에 함께 저장한다. 나중에 구성원에서 빠져도 "누가 지웠는지"가 남는다.
alter table public.customer_photos add column if not exists archived_by_name text;
-- 'deleted': 사용자가 삭제, 'upload_failed': 업로드 실패 뒤 정리(휴지통에 보이지 않는다). 사유를 주지 않은 예전 API의 삭제는 'deleted'로 본다.
alter table public.customer_photos add column if not exists archived_reason text not null default '';
alter table public.customer_photos drop constraint if exists customer_photos_archived_reason_check;
alter table public.customer_photos add constraint customer_photos_archived_reason_check check (archived_reason in ('', 'deleted', 'upload_failed'));

create index if not exists idx_customer_photos_trash
 on public.customer_photos (organization_id, customer_id, archived_at desc) where is_archived and archived_reason = 'deleted';

-- 삭제 기록은 DB가 찍는다. 클라이언트가 보낸 archived_* 값은 무시하고, 복원하면 모두 지운다.
create or replace function private.stamp_customer_photo_archive()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.is_archived and not old.is_archived then
  new.archived_at := now();
  new.archived_by := auth.uid();
  new.archived_by_name := case when auth.uid() is null then null else private.person_name(auth.uid()) end;
  if new.archived_reason = '' then new.archived_reason := 'deleted'; end if;
 elsif not new.is_archived and old.is_archived then
  new.archived_at := null; new.archived_by := null; new.archived_by_name := null; new.archived_reason := '';
 else
  new.archived_at := old.archived_at; new.archived_by := old.archived_by; new.archived_by_name := old.archived_by_name;
  new.archived_reason := old.archived_reason;
 end if;
 return new;
end $$;
revoke all on function private.stamp_customer_photo_archive() from public, anon, authenticated;
drop trigger if exists customer_photos_stamp_archive on public.customer_photos;
create trigger customer_photos_stamp_archive before update on public.customer_photos
 for each row execute function private.stamp_customer_photo_archive();

commit;
