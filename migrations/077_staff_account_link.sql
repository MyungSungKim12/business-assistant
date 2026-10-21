-- TEAM-11: bind one existing organization member to a booking-staff record.
-- Do not use this mapping as organization authorization; membership and role remain authoritative.
begin;

alter table public.appointment_staff
 add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
create unique index if not exists appointment_staff_one_user_per_org
 on public.appointment_staff(organization_id,auth_user_id) where auth_user_id is not null;

create or replace function public.assign_appointment_staff_account(
 p_organization_id uuid,p_staff_id uuid,p_user_id uuid,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare staff_row public.appointment_staff%rowtype; prior public.appointment_operations%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 if p_staff_id is null or p_expected_version is null or p_expected_version<1 or p_operation_id is null then
  raise exception 'Invalid staff account link' using errcode='22023'; end if;
 if p_user_id is not null and not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id) then
  raise exception 'Organization member not found' using errcode='P0002'; end if;
 fp=md5(jsonb_build_object('action','staff_account_link','staff',p_staff_id,'user',p_user_id,'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('appointment-operation:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_operations where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('appointment-staff:'||p_organization_id::text||p_staff_id::text,0));
 select * into staff_row from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id for update;
 if not found then raise exception 'Staff not found' using errcode='P0002'; end if;
 if staff_row.profile_version<>p_expected_version then raise exception 'Staff changed' using errcode='P0001'; end if;
 if p_user_id is not null and exists(select 1 from public.appointment_staff s where s.organization_id=p_organization_id and s.auth_user_id=p_user_id and s.id<>p_staff_id) then
  raise exception 'Member is already linked to another staff record' using errcode='23505'; end if;
 update public.appointment_staff set auth_user_id=p_user_id,profile_version=profile_version+1
  where organization_id=p_organization_id and id=p_staff_id returning * into staff_row;
 insert into public.appointment_operations(organization_id,operation_id,actor_id,fingerprint,result_snapshot)
  values(p_organization_id,p_operation_id,auth.uid(),fp,to_jsonb(staff_row));
 return to_jsonb(staff_row);
end $$;
revoke all on function public.assign_appointment_staff_account(uuid,uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.assign_appointment_staff_account(uuid,uuid,uuid,bigint,uuid) to authenticated;

comment on column public.appointment_staff.auth_user_id is 'Optional organization member account linked to this staff profile; membership role remains the authorization source.';
commit;
