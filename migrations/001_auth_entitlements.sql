begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.memberships (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null check (role in ('owner', 'admin', 'member')),
    created_at timestamptz not null default now(),
    unique (organization_id, user_id)
);

create table public.features (
    code text primary key,
    name text not null,
    description text not null default '',
    created_at timestamptz not null default now()
);

create table public.plans (
    id uuid primary key default gen_random_uuid(),
    code text not null unique,
    name text not null,
    price_krw integer not null check (price_krw >= 0),
    billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table public.plan_features (
    plan_id uuid not null references public.plans(id) on delete cascade,
    feature_code text not null references public.features(code) on delete cascade,
    primary key (plan_id, feature_code)
);

create table public.subscriptions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    plan_id uuid not null references public.plans(id),
    status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
    starts_at timestamptz not null,
    ends_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_memberships_organization_id on public.memberships (organization_id);
create index idx_memberships_user_id on public.memberships (user_id);
create index idx_plan_features_plan_id on public.plan_features (plan_id);
create index idx_plan_features_feature_code on public.plan_features (feature_code);
create index idx_subscriptions_organization_id on public.subscriptions (organization_id);
create index idx_subscriptions_plan_id on public.subscriptions (plan_id);
create index idx_subscriptions_active_lookup
    on public.subscriptions (organization_id, ends_at)
    where status in ('trialing', 'active');

create function private.has_organization_role(
    target_organization_id uuid,
    permitted_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.memberships
        where organization_id = target_organization_id
          and user_id = (select auth.uid())
          and role = any(permitted_roles)
    );
$$;

revoke all on function private.has_organization_role(uuid, text[]) from public;
grant execute on function private.has_organization_role(uuid, text[]) to authenticated;

create function private.bootstrap_organization_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null then
        raise exception 'organization creator must be authenticated';
    end if;

    insert into public.memberships (organization_id, user_id, role)
    values (new.id, (select auth.uid()), 'owner');

    return new;
end;
$$;

revoke all on function private.bootstrap_organization_owner() from public;

create trigger organizations_create_owner_membership
after insert on public.organizations
for each row
execute function private.bootstrap_organization_owner();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.features enable row level security;
alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.subscriptions enable row level security;

create policy "profiles_select_self"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = id);

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "organizations_select_member"
on public.organizations
for select
to authenticated
using ((select private.has_organization_role(id, array['owner', 'admin', 'member']::text[])));

create policy "organizations_insert_authenticated"
on public.organizations
for insert
to authenticated
with check (true);

create policy "organizations_update_manager"
on public.organizations
for update
to authenticated
using ((select private.has_organization_role(id, array['owner', 'admin']::text[])))
with check ((select private.has_organization_role(id, array['owner', 'admin']::text[])));

create policy "organizations_delete_owner"
on public.organizations
for delete
to authenticated
using ((select private.has_organization_role(id, array['owner']::text[])));

create policy "memberships_select_member_or_manager"
on public.memberships
for select
to authenticated
using (
    user_id = (select auth.uid())
    or (select private.has_organization_role(organization_id, array['owner', 'admin']::text[]))
);

create policy "memberships_insert_manager"
on public.memberships
for insert
to authenticated
with check (
    (
        (select private.has_organization_role(organization_id, array['owner']::text[]))
        and role in ('admin', 'member')
    )
    or (
        (select private.has_organization_role(organization_id, array['admin']::text[]))
        and role = 'member'
    )
);

create policy "memberships_update_manager"
on public.memberships
for update
to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
with check (
    (
        (select private.has_organization_role(organization_id, array['owner']::text[]))
        and role in ('admin', 'member')
    )
    or (
        (select private.has_organization_role(organization_id, array['admin']::text[]))
        and role = 'member'
    )
);

create policy "memberships_delete_manager"
on public.memberships
for delete
to authenticated
using (
    (select private.has_organization_role(organization_id, array['owner']::text[]))
    or (
        (select private.has_organization_role(organization_id, array['admin']::text[]))
        and role = 'member'
    )
);

create policy "features_select_authenticated"
on public.features
for select
to authenticated
using (true);

create policy "plans_select_authenticated"
on public.plans
for select
to authenticated
using (true);

create policy "plan_features_select_authenticated"
on public.plan_features
for select
to authenticated
using (true);

create policy "subscriptions_select_member"
on public.subscriptions
for select
to authenticated
using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));

-- Subscription mutations are reserved for the trusted server/platform path.

commit;
