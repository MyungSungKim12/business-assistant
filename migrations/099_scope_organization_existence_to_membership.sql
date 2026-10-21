-- SEC-13: do not expose whether an arbitrary organization UUID exists.
begin;

create or replace function public.organization_exists(target_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null then
        raise exception 'authentication required' using errcode = '42501';
    end if;

    return exists (
        select 1
        from public.memberships
        where organization_id = target_organization_id
          and user_id = (select auth.uid())
    );
end;
$$;

revoke all on function public.organization_exists(uuid) from public;
revoke all on function public.organization_exists(uuid) from anon;
grant execute on function public.organization_exists(uuid) to authenticated;

commit;
