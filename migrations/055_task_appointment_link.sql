-- 055: TASK-01 할 일과 예약 연결.
-- 예약 연결은 선택 사항이며, 예약 삭제 시 연결만 해제한다. 고객은 연결된 예약의 실제 고객으로 유지한다.
begin;

alter table public.tasks add column if not exists appointment_id uuid;

-- 복합 외래 키는 다른 조직의 예약을 연결하지 못하게 한다. 예약을 지우면 할 일은 남는다.
alter table public.tasks drop constraint if exists tasks_appointment_scope;
alter table public.tasks add constraint tasks_appointment_scope
 foreign key (organization_id, appointment_id) references public.appointments (organization_id, id)
 on delete set null (appointment_id);
create index if not exists idx_tasks_appointment on public.tasks (organization_id, appointment_id) where appointment_id is not null;

-- 예약 연결 시 고객은 예약 레코드의 고객으로 동기화한다. 예약 연결을 해제해도 고객 연결은 보존한다.
create or replace function private.sync_task_appointment_customer()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.appointment_id is not null then
  select a.customer_id into new.customer_id
  from public.appointments a
  where a.organization_id = new.organization_id and a.id = new.appointment_id;
  if not found then
   raise exception 'Appointment must belong to the task organization' using errcode = '23503';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.sync_task_appointment_customer() from public, anon, authenticated;
drop trigger if exists tasks_sync_appointment_customer on public.tasks;
create trigger tasks_sync_appointment_customer
 before insert or update of organization_id, appointment_id, customer_id on public.tasks
 for each row execute function private.sync_task_appointment_customer();

commit;
