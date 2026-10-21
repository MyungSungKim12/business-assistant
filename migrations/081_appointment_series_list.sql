-- APT-16: organization-scoped series listing for operational review.
begin;

create or replace function public.list_appointment_series(p_organization_id uuid,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_appointment_role(p_organization_id,false);
 if p_limit is null or p_limit<1 or p_limit>100 then
  raise exception 'Invalid appointment series limit' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result
 from (
  select s.created_at,jsonb_build_object(
   'series',to_jsonb(s),
   'occurrences',coalesce((select jsonb_agg(jsonb_build_object('occurrence_number',o.occurrence_number,'scheduled_start_at',o.scheduled_start_at,'is_exception',o.is_exception,'appointment',to_jsonb(a)) order by o.occurrence_number)
    from public.appointment_series_occurrences o join public.appointments a on a.organization_id=o.organization_id and a.id=o.appointment_id
    where o.organization_id=s.organization_id and o.series_id=s.id),'[]'::jsonb),
   'exceptions',coalesce((select jsonb_agg(to_jsonb(e) order by e.exception_date) from public.appointment_series_exceptions e where e.organization_id=s.organization_id and e.series_id=s.id),'[]'::jsonb)
  ) item
  from public.appointment_series s where s.organization_id=p_organization_id
  order by s.created_at desc,s.id desc limit p_limit
 ) rows;
 return result;
end $$;
revoke all on function public.list_appointment_series(uuid,integer) from public,anon;
grant execute on function public.list_appointment_series(uuid,integer) to authenticated;
commit;
