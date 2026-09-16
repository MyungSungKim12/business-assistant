begin;
create function public.replace_organization_subscription(target_organization_id uuid, target_plan_code text, target_status text, target_starts_at timestamptz, target_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare selected_plan_id uuid;
begin
    if not exists (select 1 from public.organizations where id = target_organization_id) then raise exception 'organization not found'; end if;
    if target_ends_at is not null and target_ends_at <= target_starts_at then raise exception 'invalid subscription window'; end if;
    select id into selected_plan_id from public.plans where code = upper(trim(target_plan_code)) and is_active;
    if selected_plan_id is null then raise exception 'unknown plan code'; end if;
    if target_status not in ('trialing', 'active', 'past_due', 'canceled', 'expired') then raise exception 'unsupported subscription status'; end if;
    delete from public.subscriptions where organization_id = target_organization_id and status in ('trialing', 'active');
    insert into public.subscriptions (organization_id, plan_id, status, starts_at, ends_at) values (target_organization_id, selected_plan_id, target_status, target_starts_at, target_ends_at);
    return jsonb_build_object('organization_id', target_organization_id, 'plan_code', upper(trim(target_plan_code)));
end;
$$;
revoke all on function public.replace_organization_subscription(uuid, text, text, timestamptz, timestamptz) from public;
revoke all on function public.replace_organization_subscription(uuid, text, text, timestamptz, timestamptz) from anon;
revoke all on function public.replace_organization_subscription(uuid, text, text, timestamptz, timestamptz) from authenticated;
grant execute on function public.replace_organization_subscription(uuid, text, text, timestamptz, timestamptz) to service_role;
commit;
