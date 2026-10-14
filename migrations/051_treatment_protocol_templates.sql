-- 051: TRT-12 시술 프로토콜 템플릿.
-- 자주 하는 시술의 이름·분류·내용(진행 순서·사용 제품·주의), 상담 목표·예정 관리를 템플릿으로 저장해 두고
-- 시술 기록과 상담을 쓸 때 불러와 채운다. 템플릿은 불러올 때 값을 복사할 뿐이라 시술 기록과 연결되지 않으며,
-- 템플릿을 고치거나 지워도 이미 쓴 시술 기록은 바뀌지 않는다.
-- 새 테이블·함수·트리거·정책 추가뿐이라 기존 행을 바꾸지 않고 여러 번 실행해도 안전하다. 적용 후 API 서버를 재시작한다.
begin;

create table if not exists public.treatment_protocol_templates (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check (char_length(btrim(name)) between 1 and 120),
 category text not null default '' check (char_length(category) <= 100),
 treatment_name text not null default '' check (char_length(treatment_name) <= 200),
 notes text not null default '' check (char_length(notes) <= 10000),
 consultation_goal text not null default '' check (char_length(consultation_goal) <= 2000),
 consultation_plan text not null default '' check (char_length(consultation_plan) <= 5000),
 created_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1 check (version > 0)
);
-- 같은 매장에서 이름은 대소문자·앞뒤 공백을 무시하고 하나만 쓴다.
create unique index if not exists treatment_protocol_templates_name
 on public.treatment_protocol_templates (organization_id, lower(btrim(name)));

alter table public.treatment_protocol_templates enable row level security;
drop policy if exists treatment_protocol_templates_select on public.treatment_protocol_templates;
create policy treatment_protocol_templates_select on public.treatment_protocol_templates
 for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
drop policy if exists treatment_protocol_templates_insert on public.treatment_protocol_templates;
create policy treatment_protocol_templates_insert on public.treatment_protocol_templates
 for insert to authenticated with check (
  created_by = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
 );
drop policy if exists treatment_protocol_templates_update on public.treatment_protocol_templates;
create policy treatment_protocol_templates_update on public.treatment_protocol_templates
 for update to authenticated
 using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])))
 with check ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists treatment_protocol_templates_delete on public.treatment_protocol_templates;
create policy treatment_protocol_templates_delete on public.treatment_protocol_templates
 for delete to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
revoke all on public.treatment_protocol_templates from public, anon, authenticated;
grant select, insert, update, delete on public.treatment_protocol_templates to authenticated;

-- 수정할 때마다 버전을 올리고 시각을 찍는다. 조직과 작성자는 바꿀 수 없다. 낙관적 잠금은 API가 version 조건으로 건다.
create or replace function private.touch_treatment_protocol_template()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'Template organization and creator are immutable' using errcode = '42501';
 end if;
 new.version := old.version + 1;
 new.updated_at := now();
 new.created_at := old.created_at;
 return new;
end $$;
revoke all on function private.touch_treatment_protocol_template() from public, anon, authenticated;
drop trigger if exists treatment_protocol_templates_touch on public.treatment_protocol_templates;
create trigger treatment_protocol_templates_touch before update on public.treatment_protocol_templates
 for each row execute function private.touch_treatment_protocol_template();

commit;
