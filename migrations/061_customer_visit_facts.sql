-- CRM-011/F10: 060 이후. 수기 프로필을 변경하지 않는 사실 요약 조회.
begin;
create index if not exists customer_visits_fact_lookup on public.customer_visits(organization_id,customer_id,opened_at desc) where status<>'canceled';
create index if not exists appointments_customer_booking_lookup on public.appointments(organization_id,customer_id,start_at) where status in ('reserved','confirmed');
create index if not exists treatment_records_completed_lookup on public.treatment_records(organization_id,customer_id,treatment_date desc,id desc) where status='completed';

create or replace function public.get_customer_visit_facts(p_organization_id uuid,p_customer_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; stamp timestamptz:=now(); today date:=(now() at time zone 'Asia/Seoul')::date;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Customer access denied' using errcode='42501';
 end if;
 if p_customer_ids is null or cardinality(p_customer_ids)>200 or array_position(p_customer_ids,null) is not null then
  raise exception 'Invalid customer batch' using errcode='22023';
 end if;
 if exists(select 1 from unnest(p_customer_ids) as requested(customer_id) where not exists(select 1 from public.customers c where c.id=requested.customer_id and c.organization_id=p_organization_id)) then
  raise exception 'Customer access denied' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'organization_id',c.organization_id,'customer_id',c.id,
  'last_actual_visit_date',greatest((v.opened_at at time zone 'Asia/Seoul')::date,t.treatment_date),
  'next_appointment_at',a.start_at,'recommended_return_date',t.next_visit_date,'as_of',stamp
 ) order by c.id),'[]'::jsonb) into result
 from public.customers c
 left join lateral(select v.opened_at from public.customer_visits v where v.organization_id=c.organization_id and v.customer_id=c.id and v.status<>'canceled' and v.opened_at<=stamp order by v.opened_at desc limit 1)v on true
 left join lateral(select t.treatment_date,t.next_visit_date from public.treatment_records t where t.organization_id=c.organization_id and t.customer_id=c.id and t.status='completed' and t.treatment_date<=today order by t.treatment_date desc,t.id desc limit 1)t on true
 left join lateral(select a.start_at from public.appointments a where a.organization_id=c.organization_id and a.customer_id=c.id and a.status in ('reserved','confirmed') and a.start_at>=stamp order by a.start_at,a.id limit 1)a on true
 where c.organization_id=p_organization_id and c.id=any(p_customer_ids);
 return result;
end $$;
revoke all on function public.get_customer_visit_facts(uuid,uuid[]) from public,anon;
grant execute on function public.get_customer_visit_facts(uuid,uuid[]) to authenticated;
commit;
