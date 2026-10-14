-- 049: TASK-01 담당자 지정과 완료자 기록.
-- 담당자(assignee)는 자기에게 지정된 할 일의 상태·체크리스트만 바꿀 수 있고, 완료한 사람은 DB가 직접 기록한다(위조 불가).
-- 모두 nullable 컬럼과 함수·트리거·정책 추가라 기존 행은 바뀌지 않는다. 여러 번 실행해도 안전하다. 048 이후에 적용한다.
begin;

alter table public.tasks add column if not exists assignee_id uuid references auth.users(id) on delete set null;
alter table public.tasks add column if not exists completed_by uuid references auth.users(id) on delete set null;
alter table public.tasks add column if not exists completed_at timestamptz;
-- 완료한 사람의 이름은 완료 시점에 함께 기록한다. 나중에 구성원에서 빠져도 "누가 완료했는지"가 남는다.
alter table public.tasks add column if not exists completed_by_name text;
create index if not exists idx_tasks_assignee on public.tasks (organization_id, assignee_id) where assignee_id is not null;

-- 표시 이름: 프로필 이름, 없으면 이메일 앞부분. 이메일 전체는 노출하지 않는다.
create or replace function private.person_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
 select coalesce(nullif(btrim(p.display_name), ''), nullif(split_part(u.email::text, '@', 1), ''), '이름 없음')
 from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user
$$;
revoke all on function private.person_name(uuid) from public, anon, authenticated;

-- 담당자는 같은 조직의 구성원이어야 한다.
create or replace function private.validate_task_assignee()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
  if not exists (select 1 from public.memberships m where m.organization_id = new.organization_id and m.user_id = new.assignee_id) then
   raise exception 'Assignee must be an organization member' using errcode = '22023';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.validate_task_assignee() from public, anon, authenticated;
drop trigger if exists tasks_validate_assignee on public.tasks;
create trigger tasks_validate_assignee before insert or update of assignee_id on public.tasks
 for each row execute function private.validate_task_assignee();

-- 완료 기록: 상태가 done이 되는 순간 호출한 사용자와 시각을 찍고, 다시 열면 지운다. 클라이언트가 보낸 값은 무시한다.
create or replace function private.stamp_task_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op = 'INSERT' then
  if new.status = 'done' then
   new.completed_by := auth.uid(); new.completed_at := now(); new.completed_by_name := case when auth.uid() is null then null else private.person_name(auth.uid()) end;
  else
   new.completed_by := null; new.completed_at := null; new.completed_by_name := null;
  end if;
 elsif new.status = 'done' and old.status is distinct from 'done' then
  new.completed_by := auth.uid(); new.completed_at := now(); new.completed_by_name := case when auth.uid() is null then null else private.person_name(auth.uid()) end;
 elsif new.status is distinct from 'done' then
  new.completed_by := null; new.completed_at := null; new.completed_by_name := null;
 else
  new.completed_by := old.completed_by; new.completed_at := old.completed_at; new.completed_by_name := old.completed_by_name;
 end if;
 return new;
end $$;
revoke all on function private.stamp_task_completion() from public, anon, authenticated;
drop trigger if exists tasks_stamp_completion on public.tasks;
create trigger tasks_stamp_completion before insert or update on public.tasks
 for each row execute function private.stamp_task_completion();

-- 작성자도 관리자도 아닌 사용자(= 담당자로서만 수정 권한을 가진 구성원)는 상태와 체크리스트만 바꿀 수 있다.
create or replace function private.restrict_task_assignee_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is not null and old.created_by <> auth.uid()
    and not private.has_organization_role(old.organization_id, array['owner', 'admin']::text[]) then
  if (to_jsonb(new) - 'status' - 'checklist' - 'updated_at' - 'completed_by' - 'completed_at' - 'completed_by_name')
     is distinct from (to_jsonb(old) - 'status' - 'checklist' - 'updated_at' - 'completed_by' - 'completed_at' - 'completed_by_name') then
   raise exception 'Assignee may only change status and checklist' using errcode = '42501';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.restrict_task_assignee_update() from public, anon, authenticated;
drop trigger if exists tasks_restrict_assignee_update on public.tasks;
create trigger tasks_restrict_assignee_update before update on public.tasks
 for each row execute function private.restrict_task_assignee_update();

-- 담당자가 자기에게 지정된 할 일을 수정할 수 있는 정책(범위는 위 트리거가 제한한다).
drop policy if exists "tasks_update_assignee" on public.tasks;
create policy "tasks_update_assignee" on public.tasks for update to authenticated
 using (assignee_id = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])))
 with check (assignee_id = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));

-- 반복 할 일의 다음 회차는 같은 담당자를 이어받는다(048 함수를 담당자 포함으로 교체).
create or replace function private.spawn_next_recurring_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.status = 'done' and old.status is distinct from 'done' and new.recurrence is not null and new.due_at is not null then
  insert into public.tasks (organization_id, created_by, title, description, due_at, status, priority, labels, checklist, recurrence, customer_id, assignee_id, recurrence_source_id)
  values (
   new.organization_id, new.created_by, new.title, new.description, private.next_task_due(new.due_at, new.recurrence), 'open', new.priority, new.labels,
   coalesce((select jsonb_agg(jsonb_set(item, '{done}', 'false'::jsonb)) from jsonb_array_elements(new.checklist) item), '[]'::jsonb),
   new.recurrence, new.customer_id,
   -- 담당자가 그 사이 구성원에서 빠졌으면 담당자 없이 만든다(완료 처리가 실패하지 않게).
   case when exists (select 1 from public.memberships m where m.organization_id = new.organization_id and m.user_id = new.assignee_id) then new.assignee_id else null end,
   new.id
  ) on conflict (recurrence_source_id) where recurrence_source_id is not null do nothing;
 end if;
 return null;
end $$;

-- 담당자 선택용 구성원 이름 목록. 구성원 관리 목록(owner/admin 전용, 이메일 포함)과 달리 모든 구성원이 읽을 수 있고 이름만 돌려준다.
create or replace function public.list_task_people(p_org uuid)
returns table (user_id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
 if (select auth.uid()) is null or p_org is null
    or not private.has_organization_role(p_org, array['owner', 'admin', 'member']::text[]) then
  raise exception 'forbidden' using errcode = '42501';
 end if;
 return query
  select m.user_id, private.person_name(m.user_id)
  from public.memberships m
  where m.organization_id = p_org
  order by 2, m.user_id;
end $$;
revoke all on function public.list_task_people(uuid) from public, anon;
grant execute on function public.list_task_people(uuid) to authenticated;

commit;
