-- 050: SVC-11 서비스별 담당 가능 직원.
-- 서비스에 담당 가능 직원을 지정하면 그 직원만 해당 서비스의 예약을 맡을 수 있다. 지정이 하나도 없으면(기본) 모든 직원이 가능해
-- 기존 예약·서비스의 동작은 바뀌지 않는다. 새 테이블·함수·트리거 추가뿐이라 기존 행을 바꾸지 않고 여러 번 실행해도 안전하다.
-- 034(예약) 이후 언제든 적용할 수 있다. 적용 후 API 서버를 재시작한다.
begin;

create table if not exists public.appointment_service_staff (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 service_id uuid not null,
 staff_id uuid not null,
 created_at timestamptz not null default now(),
 primary key (organization_id, service_id, staff_id),
 foreign key (organization_id, service_id) references public.appointment_services (organization_id, id) on delete cascade,
 foreign key (organization_id, staff_id) references public.appointment_staff (organization_id, id) on delete cascade
);
create index if not exists idx_appointment_service_staff_staff on public.appointment_service_staff (organization_id, staff_id);
alter table public.appointment_service_staff enable row level security;
drop policy if exists appointment_service_staff_select_member on public.appointment_service_staff;
create policy appointment_service_staff_select_member on public.appointment_service_staff
 for select to authenticated using (
  (select private.has_organization_role(organization_id, array['owner','admin','member']::text[]))
 );
revoke all on public.appointment_service_staff from public, anon, authenticated;
grant select on public.appointment_service_staff to authenticated;

-- 서비스의 담당 가능 직원 목록을 통째로 바꾼다(owner/admin). 빈 배열이면 제한을 없앤다(모든 직원 가능).
create or replace function public.set_appointment_service_staff(
 p_organization_id uuid, p_service_id uuid, p_staff_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare staff_ids uuid[];
begin
 perform private.assert_appointment_role(p_organization_id, true);
 if p_service_id is null or p_staff_ids is null or coalesce(array_length(p_staff_ids, 1), 0) > 100
    or array_position(p_staff_ids, null) is not null
    or (select count(distinct x) from unnest(p_staff_ids) x) <> coalesce(array_length(p_staff_ids, 1), 0) then
  raise exception 'Invalid service staff list' using errcode = '22023';
 end if;
 perform 1 from public.appointment_services where organization_id = p_organization_id and id = p_service_id for update;
 if not found then raise exception 'Appointment service not found' using errcode = 'P0002'; end if;
 if exists (
  select 1 from unnest(p_staff_ids) x
  where not exists (select 1 from public.appointment_staff s where s.organization_id = p_organization_id and s.id = x)
 ) then
  raise exception 'Staff not found' using errcode = '22023';
 end if;
 delete from public.appointment_service_staff where organization_id = p_organization_id and service_id = p_service_id;
 insert into public.appointment_service_staff (organization_id, service_id, staff_id)
  select p_organization_id, p_service_id, x from unnest(p_staff_ids) x;
 select coalesce(array_agg(m.staff_id order by m.staff_id), '{}') into staff_ids
  from public.appointment_service_staff m where m.organization_id = p_organization_id and m.service_id = p_service_id;
 return to_jsonb(staff_ids);
end $$;
revoke all on function public.set_appointment_service_staff(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_appointment_service_staff(uuid, uuid, uuid[]) to authenticated;

-- 예약을 만들거나 담당자·서비스를 바꿀 때만 검사한다. 시간만 바꾸는 수정이나 상태 변경은 검사하지 않아,
-- 나중에 담당 가능 목록에서 빠진 직원의 기존 예약도 계속 관리할 수 있다.
create or replace function private.enforce_service_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op = 'UPDATE' and new.staff_id = old.staff_id and new.service_id = old.service_id then
  return new;
 end if;
 if exists (select 1 from public.appointment_service_staff m where m.organization_id = new.organization_id and m.service_id = new.service_id)
    and not exists (select 1 from public.appointment_service_staff m where m.organization_id = new.organization_id and m.service_id = new.service_id and m.staff_id = new.staff_id) then
  raise exception 'Staff cannot perform this service' using errcode = '22023';
 end if;
 return new;
end $$;
revoke all on function private.enforce_service_staff() from public, anon, authenticated;
drop trigger if exists appointments_enforce_service_staff on public.appointments;
create trigger appointments_enforce_service_staff before insert or update of staff_id, service_id on public.appointments
 for each row execute function private.enforce_service_staff();

commit;
