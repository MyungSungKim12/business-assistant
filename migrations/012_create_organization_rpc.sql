begin;

create or replace function public.create_organization(target_name text, target_slug text)
returns setof public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
    created public.organizations;
begin
    if (select auth.uid()) is null then
        raise exception 'organization creator must be authenticated';
    end if;
    insert into public.organizations (name, slug)
    values (btrim(target_name), btrim(target_slug))
    returning * into created;
    return next created;
end;
$$;

revoke all on function public.create_organization(text, text) from public;
grant execute on function public.create_organization(text, text) to authenticated;

commit;
