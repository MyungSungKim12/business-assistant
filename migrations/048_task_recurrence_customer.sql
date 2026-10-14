-- 048: TASK-01 반복 할 일과 고객 연결.
-- 모두 nullable/기본값 컬럼과 함수·트리거 추가라 기존 행은 바뀌지 않는다. 여러 번 실행해도 안전하다(멱등). 047 이후에 적용한다.
-- 담당자 지정은 이번에 넣지 않았다: 구성원 목록은 owner/admin만 읽을 수 있고, 할 일 수정은 작성자·관리자만 할 수 있어
-- 담당자가 완료 처리를 못 하는 문제가 있어 권한 설계가 먼저 필요하다.
begin;

alter table public.tasks add column if not exists recurrence text;
alter table public.tasks add column if not exists customer_id uuid;
alter table public.tasks add column if not exists recurrence_source_id uuid;

alter table public.tasks drop constraint if exists tasks_recurrence_check;
alter table public.tasks add constraint tasks_recurrence_check
 check (recurrence is null or recurrence in ('daily', 'weekly', 'monthly'));

-- 같은 조직의 고객만 연결할 수 있다. 고객을 삭제하면 연결만 끊어진다(customer_id만 null).
alter table public.tasks drop constraint if exists tasks_customer_scope;
alter table public.tasks add constraint tasks_customer_scope
 foreign key (customer_id, organization_id) references public.customers (id, organization_id)
 on delete set null (customer_id);
create index if not exists idx_tasks_customer on public.tasks (organization_id, customer_id) where customer_id is not null;

-- 한 할 일이 낳는 다음 반복은 최대 1건이다(다시 열었다가 또 완료해도 중복 생성하지 않는다).
create unique index if not exists idx_tasks_recurrence_source on public.tasks (recurrence_source_id) where recurrence_source_id is not null;

-- 다음 기한: 한국 시간 벽시계 기준으로 일/주/월을 더하고, 이미 지난 날짜면 오늘 이후가 될 때까지 반복해서 더한다(최대 400회).
create or replace function private.next_task_due(p_due timestamptz, p_recurrence text)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare
 step interval := case p_recurrence when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;
 local_due timestamp := p_due at time zone 'Asia/Seoul';
 count_steps int := 0;
begin
 local_due := local_due + step;
 while (local_due at time zone 'Asia/Seoul') < now() and count_steps < 400 loop
  local_due := local_due + step;
  count_steps := count_steps + 1;
 end loop;
 return local_due at time zone 'Asia/Seoul';
end $$;
revoke all on function private.next_task_due(timestamptz, text) from public, anon, authenticated;

-- 반복 할 일을 완료하면 다음 할 일을 같은 트랜잭션에서 만든다. 체크리스트는 모두 미완료로 되돌려 복사한다.
create or replace function private.spawn_next_recurring_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.status = 'done' and old.status is distinct from 'done' and new.recurrence is not null and new.due_at is not null then
  insert into public.tasks (organization_id, created_by, title, description, due_at, status, priority, labels, checklist, recurrence, customer_id, recurrence_source_id)
  values (
   new.organization_id, new.created_by, new.title, new.description, private.next_task_due(new.due_at, new.recurrence), 'open', new.priority, new.labels,
   coalesce((select jsonb_agg(jsonb_set(item, '{done}', 'false'::jsonb)) from jsonb_array_elements(new.checklist) item), '[]'::jsonb),
   new.recurrence, new.customer_id, new.id
  ) on conflict (recurrence_source_id) where recurrence_source_id is not null do nothing;
 end if;
 return null;
end $$;
revoke all on function private.spawn_next_recurring_task() from public, anon, authenticated;
drop trigger if exists tasks_spawn_next_recurring on public.tasks;
create trigger tasks_spawn_next_recurring after update of status on public.tasks
 for each row execute function private.spawn_next_recurring_task();

commit;
