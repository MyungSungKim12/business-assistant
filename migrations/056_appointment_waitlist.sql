-- APT-13: internal appointment waitlist. No external notifications or auto-booking.
begin;
create table if not exists public.appointment_waitlist (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 customer_id uuid not null,
 service_id uuid not null,
 staff_id uuid,
 preferred_date date,
 note text not null default '' check (length(note) <= 1000),
 status text not null default 'waiting' check (status in ('waiting','contacted','booked','canceled')),
 version bigint not null default 1 check (version > 0),
 created_by uuid not null default auth.uid() references auth.users(id),
 updated_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organization_id,id),
 foreign key (customer_id,organization_id) references public.customers(id,organization_id) on delete cascade,
 foreign key (service_id,organization_id) references public.appointment_services(id,organization_id) on delete restrict,
 foreign key (staff_id,organization_id) references public.appointment_staff(id,organization_id) on delete set null (staff_id)
);
create index if not exists appointment_waitlist_queue on public.appointment_waitlist(organization_id,status,created_at,id);
alter table public.appointment_waitlist enable row level security;
drop policy if exists appointment_waitlist_member_select on public.appointment_waitlist;
create policy appointment_waitlist_member_select on public.appointment_waitlist for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_waitlist_member_insert on public.appointment_waitlist;
create policy appointment_waitlist_member_insert on public.appointment_waitlist for insert to authenticated
 with check (created_by=(select auth.uid()) and updated_by=(select auth.uid()) and status='waiting' and version=1 and (select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_waitlist_member_update on public.appointment_waitlist;
create policy appointment_waitlist_member_update on public.appointment_waitlist for update to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])))
 with check ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
grant select,insert,update on public.appointment_waitlist to authenticated;
create or replace function private.guard_appointment_waitlist_update() returns trigger
language plpgsql security definer set search_path='' as $$
declare manager boolean;
begin
 manager=private.has_organization_role(old.organization_id,array['owner','admin']::text[]);
 if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'Waitlist identity is immutable' using errcode='42501';
 end if;
 if new.version<>old.version+1 then raise exception 'Waitlist version conflict' using errcode='P0001'; end if;
 if not manager and (new.customer_id is distinct from old.customer_id or new.service_id is distinct from old.service_id or new.staff_id is distinct from old.staff_id or new.preferred_date is distinct from old.preferred_date or new.note is distinct from old.note) then
  raise exception 'Waitlist fields cannot be changed by staff' using errcode='42501';
 end if;
 if new.status is distinct from old.status and not ((old.status='waiting' and new.status in ('contacted','booked','canceled')) or (old.status='contacted' and new.status in ('waiting','booked','canceled'))) then
  raise exception 'Waitlist transition is not allowed' using errcode='22023';
 end if;
 new.updated_by=auth.uid();new.updated_at=now();return new;
end $$;
revoke all on function private.guard_appointment_waitlist_update() from public,anon,authenticated;
drop trigger if exists appointment_waitlist_guard_update on public.appointment_waitlist;
create trigger appointment_waitlist_guard_update before update on public.appointment_waitlist for each row execute function private.guard_appointment_waitlist_update();
commit;



