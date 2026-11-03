-- N1030-03 / SET-003: account-owned sessions and immediate business access revocation.
-- Does not revoke any real session on migration. Runtime RPCs require the caller's live session.
begin;
create or replace function private.is_account_session_active() returns boolean
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();sid_text text:=auth.jwt()->>'session_id';sid uuid;
begin
 if actor is null or sid_text is null or sid_text!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
 sid:=sid_text::uuid;
 return exists(select 1 from auth.sessions s where s.id=sid and s.user_id=actor and (s.not_after is null or s.not_after>statement_timestamp()));
end $$;
revoke all on function private.is_account_session_active() from public,anon,authenticated;

create or replace function public.assert_current_session() returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_account_session_active() then raise exception 'Current session is not active' using errcode='28000';end if;
 return true;
end $$;
revoke all on function public.assert_current_session() from public,anon,authenticated;
grant execute on function public.assert_current_session() to authenticated;

-- Replace the existing helper IN PLACE: its OID is referenced by RLS policies.
-- Renaming/copying the old function would leave those policies using the old implementation.
create or replace function private.has_organization_role(target_organization_id uuid,permitted_roles text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select private.is_account_session_active() and exists(
  select 1 from public.memberships where organization_id=target_organization_id and user_id=(select auth.uid()) and role=any(permitted_roles)
 );
$$;
revoke all on function private.has_organization_role(uuid,text[]) from public,anon;
grant execute on function private.has_organization_role(uuid,text[]) to authenticated;

create or replace function public.list_account_sessions(p_cursor uuid default null,p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();sid uuid;result jsonb;
begin
 perform public.assert_current_session();
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'Invalid session page size' using errcode='22023';end if;
 sid:=(auth.jwt()->>'session_id')::uuid;
 with eligible as materialized(
  select s.id,s.created_at,coalesce(s.refreshed_at at time zone 'UTC',s.updated_at,s.created_at) as last_active_at,
   left(s.user_agent,256) as user_agent
  from auth.sessions s where s.user_id=actor and (s.not_after is null or s.not_after>statement_timestamp())
 ),page as materialized(
  select * from eligible where p_cursor is null or id>p_cursor order by id limit p_limit
 )
 select jsonb_build_object('current_session_id',sid,'total',(select count(*) from eligible),
  'items',coalesce((select jsonb_agg(jsonb_build_object('session_id',id,'created_at',created_at,'last_active_at',last_active_at,'user_agent',user_agent,'is_current',id=sid) order by id) from page),'[]'::jsonb),
  'next_cursor',case when exists(select 1 from eligible where id>(select id from page order by id desc limit 1)) then (select id from page order by id desc limit 1) else null end
 ) into result;
 return result;
end $$;
revoke all on function public.list_account_sessions(uuid,integer) from public,anon,authenticated;
grant execute on function public.list_account_sessions(uuid,integer) to authenticated;

create or replace function public.revoke_account_sessions(p_session_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid();sid uuid;affected integer;current_revoked boolean;
begin
 perform public.assert_current_session();
 sid:=(auth.jwt()->>'session_id')::uuid;
 -- Never let a signed-in user use this endpoint to test/revoke another user's session.
 if p_session_id is not null and exists(select 1 from auth.sessions where id=p_session_id and user_id<>actor) then
  raise exception 'Session access denied' using errcode='42501';
 end if;
 delete from auth.sessions where user_id=actor and (p_session_id is null or id=p_session_id);
 get diagnostics affected=row_count;
 current_revoked:=p_session_id is null or p_session_id=sid;
 if affected>0 then
  insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata)
  values(null,actor,'account.sessions_revoked','account_session',coalesce(p_session_id,sid)::text,
   jsonb_build_object('scope',case when p_session_id is null then 'all' else 'selected' end,'revoked_count',affected,'current_revoked',current_revoked));
 end if;
 return jsonb_build_object('revoked_count',affected,'current_revoked',current_revoked);
end $$;
revoke all on function public.revoke_account_sessions(uuid) from public,anon,authenticated;
grant execute on function public.revoke_account_sessions(uuid) to authenticated;
comment on function public.list_account_sessions(uuid,integer) is 'Own live sessions only, bounded keyset pages. No IP, refresh token, HMAC key or other secret fields.';
comment on function public.revoke_account_sessions(uuid) is 'Own selected/all sessions only. auth.sessions deletion cascades refresh tokens; live session checks gate API and organization RLS/RPC access.';

-- UID-only bootstrap/account policies must also reject a revoked-but-unexpired JWT.
-- These policies preserve their existing owner/subject predicates.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated using((select auth.uid())=id and (select public.assert_current_session()));
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check((select auth.uid())=id and (select public.assert_current_session()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using((select auth.uid())=id and (select public.assert_current_session())) with check((select auth.uid())=id and (select public.assert_current_session()));
drop policy if exists organizations_insert_authenticated on public.organizations;
create policy organizations_insert_authenticated on public.organizations for insert to authenticated with check((select auth.uid()) is not null and (select public.assert_current_session()));
-- The original self-membership OR branch bypasses has_organization_role();
-- guard the complete predicate so revoked JWTs cannot read their old membership.
drop policy if exists memberships_select_member_or_manager on public.memberships;
create policy memberships_select_member_or_manager on public.memberships for select to authenticated using(
 (select public.assert_current_session())
 and (user_id=(select auth.uid()) or (select private.has_organization_role(organization_id,array['owner','admin']::text[])))
);

-- Preserve creator/assignee access rules while guarding the entire OR branches.
drop policy if exists tasks_delete_creator_or_manager on public.tasks;
create policy tasks_delete_creator_or_manager on public.tasks for delete to authenticated using(
 (select public.assert_current_session())
 and (created_by=(select auth.uid()) or (select private.has_organization_role(organization_id,array['owner','admin']::text[])))
);
drop policy if exists tasks_update_creator_or_manager on public.tasks;
create policy tasks_update_creator_or_manager on public.tasks for update to authenticated
 using((select public.assert_current_session()) and (created_by=(select auth.uid()) or (select private.has_organization_role(organization_id,array['owner','admin']::text[]))))
 with check((select public.assert_current_session()) and (created_by=(select auth.uid()) or (select private.has_organization_role(organization_id,array['owner','admin']::text[]))));

-- Staff self-service leave access has the same self-ID OR issue as memberships.
drop policy if exists appointment_staff_leave_request_select on public.appointment_staff_time_off_requests;
create policy appointment_staff_leave_request_select on public.appointment_staff_time_off_requests for select to authenticated using(
 (select public.assert_current_session())
 and ((select private.has_organization_role(organization_id,array['owner','admin']::text[])) or exists(
  select 1 from public.appointment_staff s where s.organization_id=appointment_staff_time_off_requests.organization_id
   and s.id=appointment_staff_time_off_requests.staff_id and s.auth_user_id=(select auth.uid())))
);
drop policy if exists appointment_staff_leave_event_select on public.appointment_staff_time_off_request_events;
create policy appointment_staff_leave_event_select on public.appointment_staff_time_off_request_events for select to authenticated using(
 (select public.assert_current_session())
 and ((select private.has_organization_role(organization_id,array['owner','admin']::text[])) or exists(
  select 1 from public.appointment_staff_time_off_requests r join public.appointment_staff s
   on s.organization_id=r.organization_id and s.id=r.staff_id
  where r.organization_id=appointment_staff_time_off_request_events.organization_id
   and r.id=appointment_staff_time_off_request_events.request_id and s.auth_user_id=(select auth.uid())))
);

-- Preserve 012_create_organization_rpc.sql behavior; add live-session entry guard.
create or replace function public.create_organization(target_name text, target_slug text)
returns setof public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
    created public.organizations;
begin
 perform public.assert_current_session();
    if (select auth.uid()) is null then
        raise exception 'organization creator must be authenticated';
    end if;
    insert into public.organizations (name, slug)
    values (btrim(target_name), btrim(target_slug))
    returning * into created;
    return next created;
end;
$$;

-- Preserve 099_scope_organization_existence_to_membership.sql behavior; add live-session entry guard.
create or replace function public.organization_exists(target_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
 perform public.assert_current_session();
    if (select auth.uid()) is null then
        raise exception 'authentication required' using errcode = '42501';
    end if;

    return exists (
        select 1
        from public.memberships
        where organization_id = target_organization_id
          and user_id = (select auth.uid())
    );
end;
$$;

-- Preserve 045_organization_members.sql behavior; add live-session entry guard.
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
 perform public.assert_current_session();
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

-- Preserve 045_organization_members.sql behavior; add live-session entry guard.
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
 perform public.assert_current_session();
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

revoke all on function public.create_organization(text,text),public.organization_exists(uuid),public.add_organization_member_by_email(uuid,text,text),public.remove_organization_member(uuid,uuid) from public,anon;
grant execute on function public.create_organization(text,text),public.organization_exists(uuid),public.add_organization_member_by_email(uuid,text,text),public.remove_organization_member(uuid,uuid) to authenticated;
commit;
