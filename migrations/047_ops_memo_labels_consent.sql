-- 047: 예약 메모(APT-14), 할 일 라벨·체크리스트(TASK-02), 고객 마케팅 수신 동의(CRM-13 / MKT).
-- 모든 변경은 기본값이 있는 컬럼·함수 추가라 기존 행을 바꾸지 않는다. 마이그레이션을 먼저 적용한 뒤 API 서버를 재시작한다.
begin;

-- 할 일: 라벨(최대 10개)과 체크리스트(최대 50항목). 항목 내용 검증은 API가 하고, DB는 개수·크기 상한만 보장한다.
alter table public.tasks add column if not exists labels text[] not null default '{}';
alter table public.tasks add column if not exists checklist jsonb not null default '[]'::jsonb;
alter table public.tasks drop constraint if exists tasks_labels_limit;
alter table public.tasks add constraint tasks_labels_limit
 check (cardinality(labels) <= 10 and length(array_to_string(labels, '')) <= 300);
alter table public.tasks drop constraint if exists tasks_checklist_limit;
alter table public.tasks add constraint tasks_checklist_limit
 check (jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) <= 50 and octet_length(checklist::text) <= 20000);

-- 고객: 마케팅 수신 동의. 동의 시각은 값이 바뀔 때 DB가 직접 찍으므로 클라이언트가 조작할 수 없다.
alter table public.customers add column if not exists marketing_consent boolean not null default false;
alter table public.customers add column if not exists marketing_consent_at timestamptz;
create or replace function private.stamp_marketing_consent()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op = 'INSERT' then
  new.marketing_consent_at := case when new.marketing_consent then now() else null end;
 elsif new.marketing_consent is distinct from old.marketing_consent then
  new.marketing_consent_at := case when new.marketing_consent then now() else null end;
 else
  new.marketing_consent_at := old.marketing_consent_at;
 end if;
 return new;
end $$;
revoke all on function private.stamp_marketing_consent() from public, anon, authenticated;
drop trigger if exists customers_stamp_marketing_consent on public.customers;
create trigger customers_stamp_marketing_consent before insert or update on public.customers
 for each row execute function private.stamp_marketing_consent();

-- 예약: 메모. 일정 저장(버전·충돌 검사)과 분리해 메모만 바꾸는 함수를 둔다. 예약 버전은 올리지 않는다.
alter table public.appointments add column if not exists memo text not null default '';
alter table public.appointments drop constraint if exists appointments_memo_length;
alter table public.appointments add constraint appointments_memo_length check (char_length(memo) <= 1000);

create or replace function public.set_appointment_memo(
 p_organization_id uuid, p_appointment_id uuid, p_memo text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.appointments%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id, false);
 if p_appointment_id is null or p_memo is null or char_length(p_memo) > 1000 then
  raise exception 'Invalid appointment memo' using errcode = '22023';
 end if;
 update public.appointments
  set memo = p_memo, updated_by = auth.uid(), updated_at = now()
  where organization_id = p_organization_id and id = p_appointment_id
  returning * into r;
 if not found then raise exception 'Appointment not found' using errcode = 'P0002'; end if;
 return to_jsonb(r);
end $$;
revoke all on function public.set_appointment_memo(uuid, uuid, text) from public, anon;
grant execute on function public.set_appointment_memo(uuid, uuid, text) to authenticated;

commit;
