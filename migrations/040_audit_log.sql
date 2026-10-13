-- 040: SEC-04 감사 로그(append-only).
-- 누가(actor)·언제(created_at)·무엇을(action, target)·어디서(request_id, ip)를 남긴다. 개인정보는 넣지 않는다(metadata 는 식별자·금액 정도).
-- 쓰기 경로는 둘뿐이다.
--   1) 일반 API: 사용자 토큰으로 호출하는 보안 정의 함수 public.record_audit_event (actor 는 auth.uid() 로 강제, 조직 구성원만).
--   2) 관리자 API(admin-server): 서비스 키로 직접 insert (source = 'service').
-- 조회는 조직 owner/admin 만(RLS). update/delete/truncate 는 트리거로 막는다.
-- organization_id·actor_id 에는 외래 키를 두지 않는다: 조직이나 사용자가 지워져도 감사 기록은 남아야 하고, 삭제가 막히면 안 된다.
-- 마이그레이션 039 다음에 실행한다. 여러 번 실행해도 안전하다.
begin;

create table if not exists public.audit_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid,
 actor_id uuid,
 action text not null check (action ~ '^[a-z][a-z0-9_]{1,40}(\.[a-z][a-z0-9_]{1,40}){1,2}$'),
 target_type text not null check (target_type ~ '^[a-z][a-z0-9_]{1,40}$'),
 target_id text check (target_id is null or length(target_id) <= 200),
 metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(metadata) = 'object' and length(metadata::text) <= 4000),
 request_id text check (request_id is null or length(request_id) <= 100),
 ip inet,
 source text not null default 'api_user' check (source in ('api_user', 'service')),
 created_at timestamptz not null default now(),
 check (source = 'service' or actor_id is not null)
);

create index if not exists audit_events_org_created
 on public.audit_events (organization_id, created_at desc, id desc);
create index if not exists audit_events_org_action_created
 on public.audit_events (organization_id, action, created_at desc);
create index if not exists audit_events_actor_created
 on public.audit_events (actor_id, created_at desc);

alter table public.audit_events enable row level security;

drop policy if exists audit_events_select_admin on public.audit_events;
create policy audit_events_select_admin on public.audit_events
 for select to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

-- 일반 사용자 역할에는 조회만. insert 는 보안 정의 함수와 서비스 키(service_role)만 한다.
revoke all on public.audit_events from public, anon, authenticated, service_role;
grant select on public.audit_events to authenticated;
grant select, insert on public.audit_events to service_role;

create or replace function private.prevent_audit_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
 raise exception 'audit_events is append-only' using errcode = 'P0001';
end;
$$;

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
 before update or delete on public.audit_events
 for each row execute function private.prevent_audit_event_change();

drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate
 before truncate on public.audit_events
 for each statement execute function private.prevent_audit_event_change();

create or replace function public.record_audit_event(
 p_organization_id uuid,
 p_action text,
 p_target_type text,
 p_target_id text default null,
 p_metadata jsonb default '{}'::jsonb,
 p_request_id text default null,
 p_ip inet default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
 caller uuid := (select auth.uid());
 new_id uuid;
begin
 if caller is null then
  raise exception 'authentication required' using errcode = '42501';
 end if;
 if p_organization_id is null then
  raise exception 'organization is required' using errcode = '22023';
 end if;
 if not private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[]) then
  raise exception 'organization membership required' using errcode = '42501';
 end if;
 if p_action is null or p_action !~ '^[a-z][a-z0-9_]{1,40}(\.[a-z][a-z0-9_]{1,40}){1,2}$' then
  raise exception 'invalid audit action' using errcode = '22023';
 end if;
 if p_target_type is null or p_target_type !~ '^[a-z][a-z0-9_]{1,40}$' then
  raise exception 'invalid audit target type' using errcode = '22023';
 end if;
 if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' or length(coalesce(p_metadata, '{}'::jsonb)::text) > 4000 then
  raise exception 'invalid audit metadata' using errcode = '22023';
 end if;

 -- actor 와 source 는 호출자가 정할 수 없다.
 insert into public.audit_events (organization_id, actor_id, action, target_type, target_id, metadata, request_id, ip, source)
 values (p_organization_id, caller, p_action, p_target_type, left(p_target_id, 200), coalesce(p_metadata, '{}'::jsonb), left(p_request_id, 100), p_ip, 'api_user')
 returning id into new_id;
 return new_id;
end;
$$;

revoke all on function public.record_audit_event(uuid, text, text, text, jsonb, text, inet) from public, anon;
grant execute on function public.record_audit_event(uuid, text, text, text, jsonb, text, inet) to authenticated;

commit;
