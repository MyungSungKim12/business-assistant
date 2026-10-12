-- TEAM-002 / FIN-004: read-only, explicitly incomplete operating basis.
begin;

create or replace function public.get_management_preview(
 p_organization_id uuid,p_from_date date,p_to_date date
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[])
  then raise exception 'Management report permission required' using errcode='42501'; end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>p_from_date+366
  then raise exception 'Invalid report period' using errcode='22023'; end if;
 with transactions as (
  select coalesce(sum(amount) filter(where transaction_type='income'),0) income,
   coalesce(sum(amount) filter(where transaction_type='expense'),0) expense,
   coalesce(sum(amount) filter(where category='Visit payment' and transaction_type='income'),0) visit_receipts,
   coalesce(sum(amount) filter(where category='Visit refund' and transaction_type='expense'),0) visit_refunds,
   count(*)::int entries
  from public.finance_transactions
  where organization_id=p_organization_id and transaction_date between p_from_date and p_to_date
   and not is_archived
 ), staff as (
  select l.staff_id,l.staff_name_snapshot,
   count(*)::int line_count,coalesce(sum(l.line_total),0) gross_line_total
  from public.sale_cart_lines l
  join public.sale_carts c on c.id=l.cart_id and c.organization_id=l.organization_id
  join public.customer_visits v on v.id=c.visit_id and v.organization_id=c.organization_id
  where l.organization_id=p_organization_id and l.status='active' and c.status='paid'
   and (v.closed_at at time zone 'Asia/Seoul')::date between p_from_date and p_to_date
  group by l.staff_id,l.staff_name_snapshot
 )
 select jsonb_build_object(
  'organization_id',p_organization_id,'from_date',p_from_date,'to_date',p_to_date,
  'recorded_income',t.income,'recorded_expense',t.expense,
  'recorded_net',t.income-t.expense,'transaction_count',t.entries,
  'visit_receipts',t.visit_receipts,'visit_refunds',t.visit_refunds,
  'staff_sales_basis',coalesce((select jsonb_agg(jsonb_build_object(
   'staff_id',s.staff_id,'staff_name_snapshot',s.staff_name_snapshot,
   'line_count',s.line_count,'gross_line_total',s.gross_line_total)
   order by s.staff_name_snapshot,s.staff_id) from staff s),'[]'::jsonb),
  'is_final_profit',false,
  'excluded_costs',jsonb_build_array('inventory_cogs','staff_commissions','tax'),
  'staff_basis_is_commission',false
 ) into result from transactions t;
 return result;
end $$;
revoke all on function public.get_management_preview(uuid,date,date) from public,anon,authenticated;
grant execute on function public.get_management_preview(uuid,date,date) to authenticated;

commit;
