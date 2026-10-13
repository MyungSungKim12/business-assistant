-- 045: TEAM-10 구성원 관리(목록·이메일로 추가·역할 변경·제거).
-- Supabase Auth 이메일 초대는 서비스 키가 필요하므로 일반 API 에서는 쓰지 않는다. 대신 이미 가입한 사용자의 이메일로 조직에 추가한다.
-- 모든 함수는 보안 정의(security definer)이고 search_path 를 비워 두며, owner/admin 만 호출할 수 있다.
--   - 목록: owner/admin. 이메일은 auth.users 에서, 표시 이름은 profiles 에서 읽는다(같은 조직 구성원만).
--   - 추가: owner 는 owner/admin/member, admin 은 member 만. 가입하지 않은 이메일은 user_not_found.
--   - 역할 변경: owner 만. 본인 변경 금지(self_change), 마지막 owner 강등 금지(last_owner).
--   - 제거: owner 는 누구나, admin 은 member 만. 본인 제거 금지, 마지막 owner 제거 금지.
-- 마지막 owner 보호는 조직의 owner 행을 for update 로 잠근 뒤 센다(동시에 두 owner 가 서로를 강등/제거하는 경합 방지).
-- 감사 기록은 API 서버가 성공 응답 뒤 record_audit_event 로 남긴다(member.add / member.role_change / member.remove).
-- 마이그레이션 040 이후 언제든 실행할 수 있다(040 의 audit_events 에는 의존하지 않는다). 여러 번 실행해도 안전하다.
begin;

create or replace function public.list_organization_members(p_org uuid)
returns table (user_id uuid, email text, display_name text, role text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
 if (select auth.uid()) is null then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if p_org is null or not private.has_organization_role(p_org, array['owner', 'admin']::text[]) then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 return query
  select m.user_id, u.email::text, nullif(p.display_name, ''), m.role, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.organization_id = p_org
  order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.created_at asc, m.user_id asc;
end;
$$;

create or replace function public.add_organization_member_by_email(p_org uuid, p_email text, p_role text default 'member')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
 caller uuid := (select auth.uid());
 caller_role text;
 target uuid;
 normalized text := lower(btrim(coalesce(p_email, '')));
begin
 if caller is null or p_org is null then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 select m.role into caller_role from public.memberships m where m.organization_id = p_org and m.user_id = caller;
 if caller_role is null or caller_role not in ('owner', 'admin') then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if p_role is null or p_role not in ('owner', 'admin', 'member') then
  raise exception 'invalid_role';
 end if;
 if caller_role = 'admin' and p_role <> 'member' then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if normalized = '' or length(normalized) > 254 or position('@' in normalized) < 2 then
  raise exception 'invalid_email';
 end if;
 select u.id into target from auth.users u where lower(u.email) = normalized limit 1;
 if target is null then
  raise exception 'user_not_found';
 end if;
 if exists (select 1 from public.memberships m where m.organization_id = p_org and m.user_id = target) then
  raise exception 'already_member';
 end if;
 insert into public.memberships (organization_id, user_id, role) values (p_org, target, p_role);
 return jsonb_build_object('user_id', target, 'role', p_role);
end;
$$;

create or replace function public.set_organization_member_role(p_org uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
 caller uuid := (select auth.uid());
 target_role text;
 owner_count integer;
begin
 if caller is null or p_org is null or p_user is null then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 -- 역할 변경은 owner 만 한다.
 if not private.has_organization_role(p_org, array['owner']::text[]) then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if p_role is null or p_role not in ('owner', 'admin', 'member') then
  raise exception 'invalid_role';
 end if;
 if p_user = caller then
  raise exception 'self_change';
 end if;
 -- 마지막 owner 보호: owner 행을 잠근 뒤 센다.
 perform 1 from public.memberships m where m.organization_id = p_org and m.role = 'owner' for update;
 select m.role into target_role from public.memberships m where m.organization_id = p_org and m.user_id = p_user;
 if target_role is null then
  raise exception 'member_not_found';
 end if;
 if target_role = 'owner' and p_role <> 'owner' then
  select count(*) into owner_count from public.memberships m where m.organization_id = p_org and m.role = 'owner';
  if owner_count <= 1 then
   raise exception 'last_owner';
  end if;
 end if;
 update public.memberships m set role = p_role where m.organization_id = p_org and m.user_id = p_user;
 return jsonb_build_object('user_id', p_user, 'role', p_role);
end;
$$;

create or replace function public.remove_organization_member(p_org uuid, p_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
 caller uuid := (select auth.uid());
 caller_role text;
 target_role text;
 owner_count integer;
begin
 if caller is null or p_org is null or p_user is null then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 select m.role into caller_role from public.memberships m where m.organization_id = p_org and m.user_id = caller;
 if caller_role is null or caller_role not in ('owner', 'admin') then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if p_user = caller then
  raise exception 'self_change';
 end if;
 perform 1 from public.memberships m where m.organization_id = p_org and m.role = 'owner' for update;
 select m.role into target_role from public.memberships m where m.organization_id = p_org and m.user_id = p_user;
 if target_role is null then
  raise exception 'member_not_found';
 end if;
 -- admin 은 일반 구성원(member)만 제거할 수 있다.
 if caller_role = 'admin' and target_role <> 'member' then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 if target_role = 'owner' then
  select count(*) into owner_count from public.memberships m where m.organization_id = p_org and m.role = 'owner';
  if owner_count <= 1 then
   raise exception 'last_owner';
  end if;
 end if;
 delete from public.memberships m where m.organization_id = p_org and m.user_id = p_user;
 return jsonb_build_object('user_id', p_user, 'removed', true);
end;
$$;

revoke all on function public.list_organization_members(uuid) from public, anon;
revoke all on function public.add_organization_member_by_email(uuid, text, text) from public, anon;
revoke all on function public.set_organization_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.remove_organization_member(uuid, uuid) from public, anon;
grant execute on function public.list_organization_members(uuid) to authenticated;
grant execute on function public.add_organization_member_by_email(uuid, text, text) to authenticated;
grant execute on function public.set_organization_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_organization_member(uuid, uuid) to authenticated;

commit;
