-- N1030-01 / CRM-011, DASH-001: bounded payload with exact organization totals.
begin;
create index if not exists customers_dashboard_active on public.customers(organization_id,id) where status <> 'archived';
create or replace function public.get_customer_dashboard(p_organization_id uuid,p_today date)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; stamp timestamptz:=now(); actual_today date:=(now() at time zone 'Asia/Seoul')::date;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Customer access denied' using errcode='42501';
 end if;
 if p_today is null then raise exception 'Invalid dashboard date' using errcode='22023'; end if;
 with active as materialized (
  select c.* from public.customers c where c.organization_id=p_organization_id and c.status<>'archived'
 ), last_dates as (
  select x.customer_id,max(x.visit_date) as last_date from (
   select v.customer_id,(v.opened_at at time zone 'Asia/Seoul')::date as visit_date from public.customer_visits v
   where v.organization_id=p_organization_id and v.status<>'canceled' and v.opened_at<=stamp
   union all
   select t.customer_id,t.treatment_date from public.treatment_records t
   where t.organization_id=p_organization_id and t.status='completed' and t.treatment_date<=actual_today
  )x group by x.customer_id
 ), next_dates as (
  select a.customer_id,min(a.start_at) as next_at from public.appointments a
  where a.organization_id=p_organization_id and a.status in ('reserved','confirmed') and a.start_at>=stamp
  group by a.customer_id
 ), recent as (
  select c,l.last_date from active c join last_dates l on l.customer_id=c.id
  order by l.last_date desc,c.name,c.id limit 5
 ), upcoming_all as materialized (
  select c,n.next_at from active c join next_dates n on n.customer_id=c.id
  where (n.next_at at time zone 'Asia/Seoul')::date between p_today and p_today+7
 ), upcoming as (
  select * from upcoming_all order by next_at,(c).name,(c).id limit 10
 )
 select jsonb_build_object('organization_id',p_organization_id,'active_count',(select count(*) from active),
  'upcoming_count',(select count(*) from upcoming_all),
  'recent',coalesce((select jsonb_agg(to_jsonb(r.c)||jsonb_build_object('last_visit_date',r.last_date,'next_visit_date',null) order by r.last_date desc,(r.c).name,(r.c).id) from recent r),'[]'::jsonb),
  'upcoming',coalesce((select jsonb_agg(to_jsonb(u.c)||jsonb_build_object('last_visit_date',null,'next_visit_date',(u.next_at at time zone 'Asia/Seoul')::date) order by u.next_at,(u.c).name,(u.c).id) from upcoming u),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.get_customer_dashboard(uuid,date) from public,anon;
grant execute on function public.get_customer_dashboard(uuid,date) to authenticated;
comment on function public.get_customer_dashboard(uuid,date) is 'Exact non-archived totals; bounded actual visits (5) and reserved/confirmed upcoming customers (10). Manual profile dates are never used or modified.';
commit;
