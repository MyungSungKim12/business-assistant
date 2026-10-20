-- TEAM-001/F14: 담당 기록은 삭제하지 않는다. 062 이후 적용.
begin;
alter table public.appointment_staff add column if not exists profile_version bigint not null default 1 check(profile_version>0);

create or replace function public.update_appointment_staff_profile(p_organization_id uuid,p_staff_id uuid,p_name text,p_is_active boolean,p_expected_version bigint,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.appointment_staff%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_staff_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 or p_is_active is null
  or p_expected_version is null or p_expected_version<1 or p_operation_id is null then
  raise exception 'Invalid staff profile' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('action','staff_profile','id',p_staff_id,'name',btrim(p_name),'active',p_is_active,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||p_staff_id::text,0));
 select * into r from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id for update;
 if not found then raise exception 'Staff not found' using errcode='P0002'; end if;
 if r.profile_version<>p_expected_version then raise exception 'Staff changed' using errcode='P0001'; end if;
 if not p_is_active and exists(select 1 from public.appointments a where a.organization_id=p_organization_id and a.staff_id=p_staff_id
  and (a.status='checked_in' or (a.status in ('reserved','confirmed') and a.end_at>now()))) then
  raise exception 'Reassign or resolve appointments first' using errcode='P0001'; end if;
 update public.appointment_staff set name=btrim(p_name),is_active=p_is_active,profile_version=profile_version+1 where id=r.id returning * into r;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.update_appointment_staff_profile(uuid,uuid,text,boolean,bigint,uuid) from public,anon;
grant execute on function public.update_appointment_staff_profile(uuid,uuid,text,boolean,bigint,uuid) to authenticated;

-- 기존 저장 RPC의 활성 확인은 advisory lock보다 앞선다. 잠금을 기다린 뒤 다시 확인한다.
create or replace function private.require_active_appointment_staff() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status in ('reserved','confirmed','checked_in') then
  perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||new.organization_id::text||new.staff_id::text,0));
  if not exists(select 1 from public.appointment_staff s where s.organization_id=new.organization_id and s.id=new.staff_id and s.is_active) then
   raise exception 'Staff is inactive' using errcode='22023'; end if;
 end if;
 return new;
end $$;
revoke all on function private.require_active_appointment_staff() from public,anon,authenticated;
drop trigger if exists require_active_appointment_staff on public.appointments;
create trigger require_active_appointment_staff before insert or update of staff_id,start_at,end_at,status on public.appointments
 for each row execute function private.require_active_appointment_staff();
commit;
