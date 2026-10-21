-- APT-20: bind scheduling records and capacity resources to an organization branch.
begin;

alter table public.appointment_staff add column if not exists branch_id uuid;
alter table public.appointment_resources add column if not exists branch_id uuid;
alter table public.appointments add column if not exists branch_id uuid;

update public.appointment_staff s set branch_id=b.id
from public.organization_branches b
where s.organization_id=b.organization_id and b.is_primary and s.branch_id is null;
update public.appointment_resources r set branch_id=b.id
from public.organization_branches b
where r.organization_id=b.organization_id and b.is_primary and r.branch_id is null;
update public.appointments a set branch_id=s.branch_id
from public.appointment_staff s
where a.organization_id=s.organization_id and a.staff_id=s.id and a.branch_id is null;

alter table public.appointment_staff alter column branch_id set not null;
alter table public.appointment_resources alter column branch_id set not null;
alter table public.appointments alter column branch_id set not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='appointment_staff_branch_fk') then
  alter table public.appointment_staff add constraint appointment_staff_branch_fk foreign key(organization_id,branch_id) references public.organization_branches(organization_id,id);
 end if;
 if not exists(select 1 from pg_constraint where conname='appointment_resources_branch_fk') then
  alter table public.appointment_resources add constraint appointment_resources_branch_fk foreign key(organization_id,branch_id) references public.organization_branches(organization_id,id);
 end if;
 if not exists(select 1 from pg_constraint where conname='appointments_branch_fk') then
  alter table public.appointments add constraint appointments_branch_fk foreign key(organization_id,branch_id) references public.organization_branches(organization_id,id);
 end if;
end $$;
create index if not exists appointment_staff_branch_active on public.appointment_staff(organization_id,branch_id,name) where is_active;
create index if not exists appointment_resources_branch_active on public.appointment_resources(organization_id,branch_id,kind,name) where is_active;
create index if not exists appointments_branch_time on public.appointments(organization_id,branch_id,start_at,end_at);

create or replace function private.assign_default_appointment_asset_branch()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.branch_id is null then
  select id into new.branch_id from public.organization_branches
   where organization_id=new.organization_id and is_primary and is_active;
 end if;
 if new.branch_id is null or not exists(select 1 from public.organization_branches
  where organization_id=new.organization_id and id=new.branch_id and is_active) then
  raise exception 'Active branch not found' using errcode='P0002';
 end if;
 return new;
end $$;
revoke all on function private.assign_default_appointment_asset_branch() from public,anon,authenticated;
drop trigger if exists appointment_staff_assign_branch on public.appointment_staff;
create trigger appointment_staff_assign_branch before insert or update of organization_id,branch_id on public.appointment_staff
 for each row execute function private.assign_default_appointment_asset_branch();
drop trigger if exists appointment_resources_assign_branch on public.appointment_resources;
create trigger appointment_resources_assign_branch before insert or update of organization_id,branch_id on public.appointment_resources
 for each row execute function private.assign_default_appointment_asset_branch();

create or replace function private.assign_appointment_branch()
returns trigger language plpgsql security definer set search_path='' as $$
declare staff_branch uuid;
begin
 select branch_id into staff_branch from public.appointment_staff
 where organization_id=new.organization_id and id=new.staff_id and is_active;
 if staff_branch is null then raise exception 'Active staff not found' using errcode='P0002'; end if;
 if new.branch_id is not null and new.branch_id<>staff_branch then
  raise exception 'Appointment branch must match assigned staff' using errcode='22023';
 end if;
 new.branch_id:=staff_branch;
 return new;
end $$;
revoke all on function private.assign_appointment_branch() from public,anon,authenticated;
drop trigger if exists appointments_assign_branch on public.appointments;
create trigger appointments_assign_branch before insert or update of organization_id,staff_id,branch_id
 on public.appointments for each row execute function private.assign_appointment_branch();

create or replace function private.enforce_appointment_resources()
returns trigger language plpgsql security definer set search_path='' as $$
declare distinct_count integer;
begin
 select count(distinct value) into distinct_count from unnest(new.resource_ids) value;
 if distinct_count<>cardinality(new.resource_ids) then raise exception 'Duplicate appointment resource' using errcode='22023'; end if;
 if exists(select 1 from unnest(new.resource_ids) selected(resource_id)
  left join public.appointment_resources r on r.organization_id=new.organization_id and r.id=selected.resource_id
   and r.branch_id=new.branch_id and r.is_active where r.id is null) then
  raise exception 'Active branch appointment resource not found' using errcode='P0002'; end if;
 if exists(select 1 from public.appointment_service_resource_requirements requirement
  where requirement.organization_id=new.organization_id and requirement.service_id=new.service_id
   and requirement.quantity>(select count(*) from public.appointment_resources resource
    where resource.organization_id=new.organization_id and resource.branch_id=new.branch_id
     and resource.id=any(new.resource_ids) and resource.is_active and resource.kind=requirement.kind)) then
  raise exception 'Required appointment resources missing' using errcode='22023'; end if;
 if new.status in ('reserved','confirmed','checked_in') and cardinality(new.resource_ids)>0 and exists(
  select 1 from public.appointments appointment where appointment.organization_id=new.organization_id
   and appointment.branch_id=new.branch_id and appointment.id is distinct from new.id
   and appointment.status in ('reserved','confirmed','checked_in') and appointment.resource_ids && new.resource_ids
   and appointment.start_at<new.end_at+make_interval(mins=>new.buffer_minutes)
   and new.start_at<appointment.end_at+make_interval(mins=>appointment.buffer_minutes)) then
  raise exception 'Appointment resource conflict' using errcode='P0001'; end if;
 return new;
end $$;

-- Assignment changes are manager-only and blocked while future active appointments exist.
create or replace function public.assign_appointment_staff_branch(p_organization_id uuid,p_staff_id uuid,p_branch_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved public.appointment_staff%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 select * into saved from public.appointment_staff where organization_id=p_organization_id and id=p_staff_id for update;
 if not found then raise exception 'Staff not found' using errcode='P0002'; end if;
 if saved.profile_version<>p_expected_version then raise exception 'Staff changed' using errcode='P0001'; end if;
 if not exists(select 1 from public.organization_branches where organization_id=p_organization_id and id=p_branch_id and is_active) then
  raise exception 'Active branch not found' using errcode='P0002'; end if;
 if saved.branch_id<>p_branch_id and exists(select 1 from public.appointments a where a.organization_id=p_organization_id
  and a.staff_id=p_staff_id and a.start_at>now() and a.status in ('reserved','confirmed','checked_in')) then
  raise exception 'Future appointments must be reassigned before moving staff' using errcode='P0001'; end if;
 update public.appointment_staff set branch_id=p_branch_id,profile_version=profile_version+1
  where organization_id=p_organization_id and id=p_staff_id returning * into saved;
 return to_jsonb(saved);
end $$;
revoke all on function public.assign_appointment_staff_branch(uuid,uuid,uuid,bigint) from public,anon;
grant execute on function public.assign_appointment_staff_branch(uuid,uuid,uuid,bigint) to authenticated;

create or replace function public.assign_appointment_resource_branch(p_organization_id uuid,p_resource_id uuid,p_branch_id uuid,p_expected_version bigint,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved public.appointment_resources%rowtype;
begin
 perform private.assert_appointment_role(p_organization_id,true);
 select * into saved from public.appointment_resources where organization_id=p_organization_id and id=p_resource_id for update;
 if not found then raise exception 'Resource not found' using errcode='P0002'; end if;
 if saved.version<>p_expected_version or p_operation_id is null then raise exception 'Resource changed' using errcode='P0001'; end if;
 if not exists(select 1 from public.organization_branches where organization_id=p_organization_id and id=p_branch_id and is_active) then
  raise exception 'Active branch not found' using errcode='P0002'; end if;
 if saved.branch_id<>p_branch_id and exists(select 1 from public.appointments a where a.organization_id=p_organization_id
  and a.start_at>now() and a.status in ('reserved','confirmed','checked_in') and saved.id=any(a.resource_ids)) then
  raise exception 'Future appointments must be reassigned before moving resource' using errcode='P0001'; end if;
 update public.appointment_resources set branch_id=p_branch_id,version=version+1,updated_by=auth.uid(),updated_at=now()
  where organization_id=p_organization_id and id=p_resource_id returning * into saved;
 return to_jsonb(saved);
end $$;
revoke all on function public.assign_appointment_resource_branch(uuid,uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.assign_appointment_resource_branch(uuid,uuid,uuid,bigint,uuid) to authenticated;

commit;
