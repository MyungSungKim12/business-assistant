-- APT-19: internal, ranked waitlist slot offers. This stores suggestions only; it never charges a fee.
begin;

create table if not exists public.appointment_waitlist_offer_groups (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 waitlist_id uuid not null,
 created_by uuid not null references auth.users(id),
 operation_id uuid not null,
 fingerprint text not null,
 expires_at timestamptz not null,
 created_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,operation_id),
 foreign key(organization_id,waitlist_id) references public.appointment_waitlist(organization_id,id) on delete cascade
);
create table if not exists public.appointment_waitlist_offers (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 offer_group_id uuid not null,
 waitlist_id uuid not null,
 rank integer not null check(rank between 1 and 10),
 staff_id uuid not null,
 start_at timestamptz not null,
 resource_ids uuid[] not null default '{}',
 status text not null default 'offered' check(status in ('offered','accepted','dismissed','superseded','expired')),
 version bigint not null default 1 check(version>0),
 acted_by uuid references auth.users(id),
 acted_at timestamptz,
 appointment_id uuid,
 action_operation_id uuid,
 action_actor_id uuid references auth.users(id),
 action_fingerprint text,
 action_snapshot jsonb,
 created_at timestamptz not null default now(),
 unique(organization_id,id),
 unique(organization_id,offer_group_id,rank),
 foreign key(organization_id,offer_group_id) references public.appointment_waitlist_offer_groups(organization_id,id) on delete cascade,
 foreign key(organization_id,waitlist_id) references public.appointment_waitlist(organization_id,id) on delete cascade,
 foreign key(staff_id,organization_id) references public.appointment_staff(id,organization_id),
 foreign key(organization_id,appointment_id) references public.appointments(organization_id,id)
);
alter table public.appointment_waitlist_offers add column if not exists action_operation_id uuid;
alter table public.appointment_waitlist_offers add column if not exists action_actor_id uuid references auth.users(id);
alter table public.appointment_waitlist_offers add column if not exists action_fingerprint text;
alter table public.appointment_waitlist_offers add column if not exists action_snapshot jsonb;
create table if not exists public.appointment_waitlist_offer_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 offer_id uuid not null,
 action text not null check(action in ('created','accepted','dismissed','superseded','expired')),
 actor_id uuid not null references auth.users(id),
 details jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key(organization_id,offer_id) references public.appointment_waitlist_offers(organization_id,id) on delete cascade
);
create index if not exists appointment_waitlist_offer_queue on public.appointment_waitlist_offers(organization_id,waitlist_id,status,rank,created_at);
alter table public.appointment_waitlist_offer_groups enable row level security;
alter table public.appointment_waitlist_offers enable row level security;
alter table public.appointment_waitlist_offer_events enable row level security;
drop policy if exists appointment_waitlist_offer_group_member_select on public.appointment_waitlist_offer_groups;
create policy appointment_waitlist_offer_group_member_select on public.appointment_waitlist_offer_groups for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_waitlist_offer_member_select on public.appointment_waitlist_offers;
create policy appointment_waitlist_offer_member_select on public.appointment_waitlist_offers for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
drop policy if exists appointment_waitlist_offer_event_member_select on public.appointment_waitlist_offer_events;
create policy appointment_waitlist_offer_event_member_select on public.appointment_waitlist_offer_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.appointment_waitlist_offer_groups,public.appointment_waitlist_offers,public.appointment_waitlist_offer_events from public,anon,authenticated;
grant select on public.appointment_waitlist_offer_groups,public.appointment_waitlist_offers,public.appointment_waitlist_offer_events to authenticated;

create or replace function public.create_appointment_waitlist_offers(
 p_organization_id uuid,p_waitlist_id uuid,p_offers jsonb,p_expires_at timestamptz,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.appointment_waitlist%rowtype; g uuid; item jsonb; n integer:=0; saved jsonb:='[]'::jsonb;
        staff_value uuid; start_value timestamptz; resources_value uuid[]; op_prior jsonb; prior public.appointment_waitlist_offer_groups%rowtype; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_operation_id is null or jsonb_typeof(p_offers)<>'array' or jsonb_array_length(p_offers) not between 1 and 10
  or p_expires_at<=now()+interval '5 minutes' or p_expires_at>now()+interval '48 hours' then
  raise exception 'Invalid waitlist offer request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('waitlist',p_waitlist_id,'offers',p_offers,'expires_at',p_expires_at)::text);
 perform pg_advisory_xact_lock(hashtextextended('waitlist-offers:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.appointment_waitlist_offer_groups where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.created_by<>auth.uid() or prior.fingerprint<>fp then raise exception 'Waitlist offer operation conflict' using errcode='P0001'; end if;
  select jsonb_agg(to_jsonb(o) order by o.rank) into op_prior from public.appointment_waitlist_offers o where organization_id=p_organization_id and offer_group_id=prior.id;
  return coalesce(op_prior,'[]'::jsonb);
 end if;
 select * into w from public.appointment_waitlist where organization_id=p_organization_id and id=p_waitlist_id for update;
 if not found then raise exception 'Waitlist entry not found' using errcode='P0002'; end if;
 if w.status not in ('waiting','contacted') then raise exception 'Waitlist is no longer active' using errcode='P0001'; end if;
 insert into public.appointment_waitlist_offer_groups(organization_id,waitlist_id,created_by,operation_id,fingerprint,expires_at)
 values(p_organization_id,p_waitlist_id,auth.uid(),p_operation_id,fp,p_expires_at) returning id into g;
 with changed as (update public.appointment_waitlist_offers set status='superseded',version=version+1,acted_by=auth.uid(),acted_at=now()
  where organization_id=p_organization_id and waitlist_id=p_waitlist_id and status='offered' returning id)
 insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id)
 select p_organization_id,id,'superseded',auth.uid() from changed;
 for item in select value from jsonb_array_elements(p_offers) loop
  n=n+1;
  if jsonb_typeof(item)<>'object' or not (item ? 'staff_id' and item ? 'start_at') then raise exception 'Invalid offer row' using errcode='22023'; end if;
  staff_value=(item->>'staff_id')::uuid;start_value=(item->>'start_at')::timestamptz;
  if start_value<=now() or start_value>now()+interval '365 days' then raise exception 'Offer time must be in the next 365 days' using errcode='22023'; end if;
  if not exists(select 1 from public.appointment_staff where organization_id=p_organization_id and id=staff_value and is_active) then
   raise exception 'Offer staff is unavailable' using errcode='22023'; end if;
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into resources_value from jsonb_array_elements_text(coalesce(item->'resource_ids','[]'::jsonb));
  if cardinality(resources_value)>20 or cardinality(resources_value)<>(select count(distinct x) from unnest(resources_value) x) then raise exception 'Invalid offer resources' using errcode='22023'; end if;
  insert into public.appointment_waitlist_offers(organization_id,offer_group_id,waitlist_id,rank,staff_id,start_at,resource_ids)
   values(p_organization_id,g,p_waitlist_id,n,staff_value,start_value,resources_value) returning to_jsonb(appointment_waitlist_offers.*) into item;
  saved=saved||item;
  insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id,details)
   values(p_organization_id,(item->>'id')::uuid,'created',auth.uid(),jsonb_build_object('rank',n,'expires_at',p_expires_at));
 end loop;
 return saved;
end $$;
revoke all on function public.create_appointment_waitlist_offers(uuid,uuid,jsonb,timestamptz,uuid) from public,anon;
grant execute on function public.create_appointment_waitlist_offers(uuid,uuid,jsonb,timestamptz,uuid) to authenticated;

create or replace function public.list_appointment_waitlist_offers(p_organization_id uuid,p_waitlist_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if not exists(select 1 from public.appointment_waitlist where organization_id=p_organization_id and id=p_waitlist_id) then raise exception 'Waitlist entry not found' using errcode='P0002'; end if;
 with changed as (update public.appointment_waitlist_offers o set status='expired',version=o.version+1,acted_by=auth.uid(),acted_at=now()
  from public.appointment_waitlist_offer_groups g,public.appointment_waitlist w
  where o.organization_id=p_organization_id and o.waitlist_id=p_waitlist_id and o.status='offered'
   and g.organization_id=o.organization_id and g.id=o.offer_group_id and w.organization_id=o.organization_id and w.id=o.waitlist_id
   and (g.expires_at<=now() or w.status not in ('waiting','contacted')) returning o.id as offer_id)
 insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id)
 select p_organization_id,offer_id,'expired',auth.uid() from changed;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'offer_group_id',o.offer_group_id,'waitlist_id',o.waitlist_id,'rank',o.rank,'staff_id',o.staff_id,'start_at',o.start_at,'resource_ids',o.resource_ids,'status',o.status,'version',o.version,'acted_by',o.acted_by,'acted_at',o.acted_at,'appointment_id',o.appointment_id,'expires_at',g.expires_at) order by g.created_at desc,o.rank), '[]'::jsonb)
 into result from public.appointment_waitlist_offers o join public.appointment_waitlist_offer_groups g on g.organization_id=o.organization_id and g.id=o.offer_group_id
 join public.appointment_waitlist w on w.organization_id=o.organization_id and w.id=o.waitlist_id
 where o.organization_id=p_organization_id and o.waitlist_id=p_waitlist_id;
 return result;
end $$;
revoke all on function public.list_appointment_waitlist_offers(uuid,uuid) from public,anon;
grant execute on function public.list_appointment_waitlist_offers(uuid,uuid) to authenticated;

create or replace function public.act_on_appointment_waitlist_offer(
 p_organization_id uuid,p_offer_id uuid,p_action text,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.appointment_waitlist_offers%rowtype; g public.appointment_waitlist_offer_groups%rowtype; w public.appointment_waitlist%rowtype;
        booked jsonb; result jsonb; fp text;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_action not in ('accept','dismiss') or p_expected_version<1 or p_operation_id is null then raise exception 'Invalid offer action' using errcode='22023'; end if;
 select * into o from public.appointment_waitlist_offers where organization_id=p_organization_id and id=p_offer_id for update;
 if not found then raise exception 'Offer not found' using errcode='P0002'; end if;
 fp=md5(jsonb_build_object('action',p_action,'version',p_expected_version)::text);
 if o.action_operation_id=p_operation_id then
  if o.action_actor_id<>auth.uid() or o.action_fingerprint<>fp then raise exception 'Offer action retry conflict' using errcode='P0001'; end if;
  return jsonb_set(o.action_snapshot,'{replayed}','true'::jsonb,true);
 end if;
 select * into g from public.appointment_waitlist_offer_groups where organization_id=p_organization_id and id=o.offer_group_id;
 select * into w from public.appointment_waitlist where organization_id=p_organization_id and id=o.waitlist_id for update;
 if o.version<>p_expected_version then raise exception 'Offer changed' using errcode='P0001'; end if;
 if o.status='offered' and (g.expires_at<=now() or w.status not in ('waiting','contacted')) then
  update public.appointment_waitlist_offers set status='expired',version=version+1,acted_by=auth.uid(),acted_at=now() where id=o.id returning * into o;
  insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id) values(p_organization_id,o.id,'expired',auth.uid());
  result=jsonb_build_object('offer',to_jsonb(o),'appointment',null,'replayed',false);
  update public.appointment_waitlist_offers set action_operation_id=p_operation_id,action_actor_id=auth.uid(),action_fingerprint=fp,action_snapshot=result where id=o.id;
  return result;
 end if;
 if o.status<>'offered' then raise exception 'Offer is no longer active' using errcode='P0001'; end if;
 if p_action='dismiss' then
  update public.appointment_waitlist_offers set status='dismissed',version=version+1,acted_by=auth.uid(),acted_at=now() where id=o.id returning * into o;
  insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id) values(p_organization_id,o.id,'dismissed',auth.uid());
  result=jsonb_build_object('offer',to_jsonb(o),'appointment',null,'replayed',false);
  update public.appointment_waitlist_offers set action_operation_id=p_operation_id,action_actor_id=auth.uid(),action_fingerprint=fp,action_snapshot=result where id=o.id;
  return result;
 end if;
 if w.status not in ('waiting','contacted') then raise exception 'Waitlist is no longer active' using errcode='P0001'; end if;
 booked=public.book_appointment_from_waitlist(p_organization_id,w.id,o.staff_id,o.start_at,o.resource_ids,w.version,p_operation_id);
 with changed as (update public.appointment_waitlist_offers set status=case when id=o.id then 'accepted' else 'superseded' end,
  version=version+1,acted_by=auth.uid(),acted_at=now(),appointment_id=case when id=o.id then (booked->'appointment'->>'id')::uuid else null end
 where organization_id=p_organization_id and waitlist_id=o.waitlist_id and status='offered' returning id,status)
 insert into public.appointment_waitlist_offer_events(organization_id,offer_id,action,actor_id,details)
 select p_organization_id,id,status,auth.uid(),case when id=o.id then jsonb_build_object('appointment_id',(booked->'appointment'->>'id')::uuid) else '{}'::jsonb end from changed;
 result=jsonb_build_object('offer',(select to_jsonb(x) from public.appointment_waitlist_offers x where x.id=o.id),'appointment',booked->'appointment','replayed',booked->'replayed');
 update public.appointment_waitlist_offers set action_operation_id=p_operation_id,action_actor_id=auth.uid(),action_fingerprint=fp,action_snapshot=result where id=o.id;
 return result;
end $$;
revoke all on function public.act_on_appointment_waitlist_offer(uuid,uuid,text,bigint,uuid) from public,anon;
grant execute on function public.act_on_appointment_waitlist_offer(uuid,uuid,text,bigint,uuid) to authenticated;
commit;
