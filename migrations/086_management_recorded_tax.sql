-- LAB-10: distinguish profit before tax from the tax expenses actually recorded.
begin;

-- Preserve the existing reports while replacing the public wrapper. The base report
-- already validates organization access and remains private.
alter function private.get_management_preview(uuid,date,date) rename to get_management_preview_base;
alter function public.get_management_preview(uuid,date,date) set schema private;
alter function private.get_management_preview(uuid,date,date) rename to get_management_preview_with_commission;
drop function private.get_management_preview_with_commission(uuid,date,date);

create or replace function public.get_management_preview(p_organization_id uuid,p_from_date date,p_to_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
 base jsonb;
 tax_expense numeric(14,0);
 commission_total numeric(14,0);
 covered_days integer;
 pre_tax numeric(14,0);
 after_commission numeric(14,0);
 after_recorded_tax numeric(14,0);
 costs_known boolean;
 commission_complete boolean;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Management report permission required' using errcode='42501';
 end if;
 if p_from_date is null or p_to_date is null or p_to_date<p_from_date or p_to_date>p_from_date+366 then
  raise exception 'Invalid report period' using errcode='22023';
 end if;

 base=private.get_management_preview_base(p_organization_id,p_from_date,p_to_date);
 select coalesce(sum(amount),0)::numeric(14,0) into tax_expense
 from public.finance_transactions
 where organization_id=p_organization_id and transaction_type='expense' and not is_archived
  and transaction_date between p_from_date and p_to_date
  and lower(btrim(category)) in ('세금','tax','taxes','tax expense');

 select coalesce(sum(greatest(0,least(s.to_date,p_to_date)-greatest(s.from_date,p_from_date)+1)),0)::integer
 into covered_days from public.staff_commission_settlements s
 where s.organization_id=p_organization_id and s.from_date<=p_to_date and s.to_date>=p_from_date;
 select coalesce(sum(l.commission_amount),0)::numeric(14,0) into commission_total
 from public.staff_commission_settlements s join public.staff_commission_settlement_lines l
  on l.organization_id=s.organization_id and l.settlement_id=s.id
 where s.organization_id=p_organization_id and s.from_date<=p_to_date and s.to_date>=p_from_date
  and l.source_event_date between p_from_date and p_to_date;

 commission_complete=covered_days=(p_to_date-p_from_date+1);
 costs_known=coalesce((base->>'inventory_cost_unknown_units')::integer,1)=0 and base->>'inventory_cogs' is not null;
 if costs_known then
  -- recorded_net already subtracts every recorded expense, including recorded tax.
  pre_tax=(base->>'recorded_net')::numeric+tax_expense-(base->>'inventory_cogs')::numeric;
 end if;
 if costs_known and commission_complete then
  after_commission=pre_tax-commission_total;
  after_recorded_tax=after_commission-tax_expense;
 end if;

 return base||jsonb_build_object(
  'recorded_tax_expense',tax_expense::text,
  'operating_profit_before_commission_tax',case when costs_known then pre_tax::text else null end,
  'commission_settlement_complete',commission_complete,
  'commission_expense',case when commission_complete then commission_total::text else null end,
  'operating_profit_after_commission_before_tax',case when costs_known and commission_complete then after_commission::text else null end,
  'operating_profit_after_recorded_tax',case when costs_known and commission_complete then after_recorded_tax::text else null end,
  'is_final_profit',false,
  'excluded_costs',case when commission_complete then jsonb_build_array('unrecorded_taxes') else jsonb_build_array('staff_commissions','unrecorded_taxes') end,
  'staff_basis_is_commission',commission_complete
 );
end $$;

revoke all on function public.get_management_preview(uuid,date,date) from public,anon,authenticated;
grant execute on function public.get_management_preview(uuid,date,date) to authenticated;
commit;
