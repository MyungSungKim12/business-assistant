-- 097: CRM-014 조직별 보유 설정, 관계 종료, 법적 보류 기록 기반.
-- 기간 기본값을 만들지 않으며, 이 migration은 고객/파일/거래를 실제 파기하지 않는다.
begin;

create table if not exists public.customer_retention_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  profile_days integer check (profile_days between 1 and 36500),
  sensitive_notes_days integer check (sensitive_notes_days between 1 and 36500),
  treatment_photos_days integer check (treatment_photos_days between 1 and 36500),
  consent_records_days integer check (consent_records_days between 1 and 36500),
  transaction_records_days integer check (transaction_records_days between 1 and 36500),
  dispute_records_days integer check (dispute_records_days between 1 and 36500),
  audit_events_days integer check (audit_events_days between 1 and 36500),
  version bigint not null default 1 check (version > 0),
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_relationship_status (
  organization_id uuid not null,
  customer_id uuid not null,
  ended_at timestamptz not null,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, customer_id),
  constraint customer_relationship_status_customer_scope foreign key (customer_id, organization_id)
    references public.customers(id, organization_id) on delete restrict
);

create table if not exists public.customer_legal_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  reason text not null check (length(btrim(reason)) between 1 and 300),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  released_by uuid,
  released_at timestamptz,
  release_reason text check (release_reason is null or length(btrim(release_reason)) between 1 and 300),
  constraint customer_legal_holds_release_pair check (
    (released_at is null and released_by is null and release_reason is null) or
    (released_at is not null and released_by is not null and release_reason is not null)
  ),
  constraint customer_legal_holds_customer_scope foreign key (customer_id, organization_id)
    references public.customers(id, organization_id) on delete restrict
);

create unique index if not exists customer_legal_holds_one_active
  on public.customer_legal_holds (organization_id, customer_id) where released_at is null;
create index if not exists customer_legal_holds_customer_history
  on public.customer_legal_holds (organization_id, customer_id, created_at desc);

create table if not exists public.customer_retention_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid,
  actor_id uuid not null,
  action text not null check (action in ('policy_updated', 'relationship_ended', 'relationship_reopened', 'hold_created', 'hold_released')),
  reason text check (reason is null or length(reason) <= 300),
  policy_version bigint,
  occurred_at timestamptz not null default now()
);
create index if not exists customer_retention_events_org_time
  on public.customer_retention_events (organization_id, occurred_at desc, id desc);
create index if not exists customer_retention_events_customer_time
  on public.customer_retention_events (organization_id, customer_id, occurred_at desc)
  where customer_id is not null;

alter table public.customer_retention_policies enable row level security;
alter table public.customer_relationship_status enable row level security;
alter table public.customer_legal_holds enable row level security;
alter table public.customer_retention_events enable row level security;

drop policy if exists customer_retention_policies_select_manager on public.customer_retention_policies;
create policy customer_retention_policies_select_manager on public.customer_retention_policies
  for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists customer_relationship_status_select_manager on public.customer_relationship_status;
create policy customer_relationship_status_select_manager on public.customer_relationship_status
  for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists customer_legal_holds_select_manager on public.customer_legal_holds;
create policy customer_legal_holds_select_manager on public.customer_legal_holds
  for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists customer_retention_events_select_manager on public.customer_retention_events;
create policy customer_retention_events_select_manager on public.customer_retention_events
  for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));

revoke all on public.customer_retention_policies, public.customer_relationship_status, public.customer_legal_holds, public.customer_retention_events from public, anon, authenticated;
grant select on public.customer_retention_policies, public.customer_relationship_status, public.customer_legal_holds, public.customer_retention_events to authenticated;

create or replace function private.prevent_customer_retention_event_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'customer retention events are append-only' using errcode = 'P0001';
end;
$$;
revoke all on function private.prevent_customer_retention_event_change() from public, anon, authenticated;
drop trigger if exists customer_retention_events_append_only on public.customer_retention_events;
create trigger customer_retention_events_append_only before update or delete on public.customer_retention_events
  for each row execute function private.prevent_customer_retention_event_change();

create or replace function public.save_customer_retention_policy(
  p_organization_id uuid,
  p_expected_version bigint,
  p_profile_days integer,
  p_sensitive_notes_days integer,
  p_treatment_photos_days integer,
  p_consent_records_days integer,
  p_transaction_records_days integer,
  p_dispute_records_days integer,
  p_audit_events_days integer
)
returns setof public.customer_retention_policies
language plpgsql volatile security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  current_version bigint;
  next_version bigint;
  policy_row public.customer_retention_policies;
begin
  if caller is null or not private.has_organization_role(p_organization_id, array['owner','admin']::text[]) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_organization_id is null or p_expected_version is null then
    raise exception 'invalid retention policy' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(array[p_profile_days,p_sensitive_notes_days,p_treatment_photos_days,p_consent_records_days,p_transaction_records_days,p_dispute_records_days,p_audit_events_days]) d where d is not null and d not between 1 and 36500) then
    raise exception 'retention period must be between 1 and 36500 days' using errcode = '22023';
  end if;

  select version into current_version from public.customer_retention_policies where organization_id = p_organization_id for update;
  if not found then
    if p_expected_version <> 0 then raise exception 'retention policy version conflict' using errcode = '40001'; end if;
    next_version := 1;
    insert into public.customer_retention_policies (
      organization_id, profile_days, sensitive_notes_days, treatment_photos_days, consent_records_days,
      transaction_records_days, dispute_records_days, audit_events_days, version, updated_by
    ) values (
      p_organization_id, p_profile_days, p_sensitive_notes_days, p_treatment_photos_days, p_consent_records_days,
      p_transaction_records_days, p_dispute_records_days, p_audit_events_days, next_version, caller
    ) returning * into policy_row;
  else
    if current_version <> p_expected_version then raise exception 'retention policy version conflict' using errcode = '40001'; end if;
    next_version := current_version + 1;
    update public.customer_retention_policies set
      profile_days = p_profile_days, sensitive_notes_days = p_sensitive_notes_days,
      treatment_photos_days = p_treatment_photos_days, consent_records_days = p_consent_records_days,
      transaction_records_days = p_transaction_records_days, dispute_records_days = p_dispute_records_days,
      audit_events_days = p_audit_events_days, version = next_version, updated_by = caller, updated_at = now()
      where organization_id = p_organization_id returning * into policy_row;
  end if;

  insert into public.customer_retention_events (organization_id, actor_id, action, policy_version)
    values (p_organization_id, caller, 'policy_updated', next_version);
  return next policy_row;
end;
$$;

create or replace function public.set_customer_relationship_end(
  p_organization_id uuid, p_customer_id uuid, p_ended_at timestamptz, p_reason text
)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.has_organization_role(p_organization_id, array['owner','admin']::text[]) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_organization_id is null or p_customer_id is null or p_reason is null or length(btrim(p_reason)) not between 1 and 300 then
    raise exception 'invalid relationship end' using errcode = '22023';
  end if;
  if p_ended_at is not null and p_ended_at > now() then
    raise exception 'relationship end cannot be in the future' using errcode = '22023';
  end if;
  if p_ended_at is not null and exists (
    select 1 from public.appointments a where a.organization_id = p_organization_id and a.customer_id = p_customer_id
      and a.status in ('reserved','confirmed','checked_in')
  ) then
    raise exception 'resolve active appointments before ending the customer relationship' using errcode = 'P0001';
  end if;
  if p_ended_at is not null and exists (
    select 1 from public.customer_wallets w where w.organization_id = p_organization_id and w.customer_id = p_customer_id
      and (w.money_balance > 0 or w.count_balance > 0)
  ) then
    raise exception 'resolve customer membership balances before ending the relationship' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and organization_id = p_organization_id) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_ended_at is null then
    delete from public.customer_relationship_status where customer_id = p_customer_id and organization_id = p_organization_id;
  else
    insert into public.customer_relationship_status (organization_id, customer_id, ended_at, updated_by)
      values (p_organization_id, p_customer_id, p_ended_at, caller)
      on conflict (organization_id, customer_id) do update set ended_at = excluded.ended_at, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.customer_retention_events (organization_id, customer_id, actor_id, action, reason)
    values (p_organization_id, p_customer_id, caller, case when p_ended_at is null then 'relationship_reopened' else 'relationship_ended' end, left(btrim(p_reason), 300));
  return p_ended_at;
end;
$$;

create or replace function public.set_customer_legal_hold(
  p_organization_id uuid, p_customer_id uuid, p_active boolean, p_reason text
)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  hold_id uuid;
begin
  if caller is null or not private.has_organization_role(p_organization_id, array['owner','admin']::text[]) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_organization_id is null or p_customer_id is null or p_active is null or p_reason is null or length(btrim(p_reason)) not between 1 and 300 then
    raise exception 'invalid legal hold' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and organization_id = p_organization_id) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_active then
    if exists (select 1 from public.customer_legal_holds where organization_id = p_organization_id and customer_id = p_customer_id and released_at is null) then
      raise exception 'legal hold already active' using errcode = '23505';
    end if;
    insert into public.customer_legal_holds (organization_id, customer_id, reason, created_by)
      values (p_organization_id, p_customer_id, left(btrim(p_reason), 300), caller) returning id into hold_id;
    insert into public.customer_retention_events (organization_id, customer_id, actor_id, action, reason)
      values (p_organization_id, p_customer_id, caller, 'hold_created', left(btrim(p_reason), 300));
  else
    update public.customer_legal_holds set released_by = caller, released_at = now(), release_reason = left(btrim(p_reason), 300)
      where organization_id = p_organization_id and customer_id = p_customer_id and released_at is null
      returning id into hold_id;
    if not found then raise exception 'no active hold' using errcode = 'P0002'; end if;
    insert into public.customer_retention_events (organization_id, customer_id, actor_id, action, reason)
      values (p_organization_id, p_customer_id, caller, 'hold_released', left(btrim(p_reason), 300));
  end if;
  return hold_id;
end;
$$;

revoke all on function public.save_customer_retention_policy(uuid,bigint,integer,integer,integer,integer,integer,integer,integer) from public, anon;
revoke all on function public.set_customer_relationship_end(uuid,uuid,timestamptz,text) from public, anon;
revoke all on function public.set_customer_legal_hold(uuid,uuid,boolean,text) from public, anon;
grant execute on function public.save_customer_retention_policy(uuid,bigint,integer,integer,integer,integer,integer,integer,integer) to authenticated;
grant execute on function public.set_customer_relationship_end(uuid,uuid,timestamptz,text) to authenticated;
grant execute on function public.set_customer_legal_hold(uuid,uuid,boolean,text) to authenticated;

commit;
