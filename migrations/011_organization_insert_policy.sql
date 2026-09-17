begin;

-- 기존 001 마이그레이션이 부분 적용되었거나 정책이 누락된 프로젝트를 보정한다.
drop policy if exists "organizations_insert_authenticated" on public.organizations;
create policy "organizations_insert_authenticated"
on public.organizations
for insert
to authenticated
with check ((select auth.uid()) is not null);

grant insert on public.organizations to authenticated;

commit;
