-- 095: CRM-14 D-10 정책 결정 전 고객 영구 삭제 경로 차단.
-- 기존 화면 밖 DELETE 경로까지 DB 권한에서 닫는다. 보관/복원은 status UPDATE를 계속 사용한다.
begin;

drop policy if exists "customers_delete_manager" on public.customers;
revoke delete on table public.customers from public, anon, authenticated;

commit;
