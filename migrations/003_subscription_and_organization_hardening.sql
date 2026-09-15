begin;

create unique index idx_subscriptions_one_active_per_organization
    on public.subscriptions (organization_id)
    where status in ('trialing', 'active');

create function public.organization_exists(target_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null then
        raise exception 'authentication required';
    end if;

    return exists (
        select 1
        from public.organizations
        where id = target_organization_id
    );
end;
$$;

revoke all on function public.organization_exists(uuid) from public;
grant execute on function public.organization_exists(uuid) to authenticated;

commit;
