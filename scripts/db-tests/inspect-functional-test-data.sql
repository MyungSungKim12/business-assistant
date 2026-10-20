-- SELECT만 실행합니다. 기존 Supabase 데이터는 변경하지 않습니다.
-- 기본 조직 ID는 이전 앱 로그에 나온 값입니다. 다른 테스트 조직이면 UUID 한 곳만 바꾸세요.
-- 결과는 건수·상태·요금제만 포함하며 고객 이름, 연락처, 메모, 파일명은 반환하지 않습니다.

with target as (
  select 'cfe8bf07-798a-4194-8bdd-0cb1b3c8df57'::uuid as organization_id
), counts as (
  select 'memberships'::text as area,(select count(*) from public.memberships x,target where x.organization_id=target.organization_id)::bigint as rows
  union all select 'subscriptions',(select count(*) from public.subscriptions x,target where x.organization_id=target.organization_id)
  union all select 'customers',(select count(*) from public.customers x,target where x.organization_id=target.organization_id)
  union all select 'appointments',(select count(*) from public.appointments x,target where x.organization_id=target.organization_id)
  union all select 'appointment_staff',(select count(*) from public.appointment_staff x,target where x.organization_id=target.organization_id)
  union all select 'appointment_services',(select count(*) from public.appointment_services x,target where x.organization_id=target.organization_id)
  union all select 'appointment_resources',(select count(*) from public.appointment_resources x,target where x.organization_id=target.organization_id)
  union all select 'appointment_waitlist',(select count(*) from public.appointment_waitlist x,target where x.organization_id=target.organization_id)
  union all select 'customer_visits',(select count(*) from public.customer_visits x,target where x.organization_id=target.organization_id)
  union all select 'treatment_records',(select count(*) from public.treatment_records x,target where x.organization_id=target.organization_id)
  union all select 'sale_carts',(select count(*) from public.sale_carts x,target where x.organization_id=target.organization_id)
  union all select 'sale_cart_lines',(select count(*) from public.sale_cart_lines x,target where x.organization_id=target.organization_id)
  union all select 'visit_payment_receipts',(select count(*) from public.visit_payment_receipts x,target where x.organization_id=target.organization_id)
  union all select 'customer_wallets',(select count(*) from public.customer_wallets x,target where x.organization_id=target.organization_id)
  union all select 'catalog_products',(select count(*) from public.catalog_products x,target where x.organization_id=target.organization_id)
  union all select 'catalog_stock_ledger',(select count(*) from public.catalog_stock_ledger x,target where x.organization_id=target.organization_id)
  union all select 'catalog_suppliers',(select count(*) from public.catalog_suppliers x,target where x.organization_id=target.organization_id)
  union all select 'catalog_purchase_orders',(select count(*) from public.catalog_purchase_orders x,target where x.organization_id=target.organization_id)
  union all select 'finance_transactions',(select count(*) from public.finance_transactions x,target where x.organization_id=target.organization_id)
  union all select 'finance_recurring_expenses',(select count(*) from public.finance_recurring_expenses x,target where x.organization_id=target.organization_id)
  union all select 'tasks',(select count(*) from public.tasks x,target where x.organization_id=target.organization_id)
  union all select 'documents',(select count(*) from public.documents x,target where x.organization_id=target.organization_id)
  union all select 'document_templates',(select count(*) from public.document_templates x,target where x.organization_id=target.organization_id)
  union all select 'file_assets',(select count(*) from public.file_assets x,target where x.organization_id=target.organization_id)
  union all select 'customer_photos',(select count(*) from public.customer_photos x,target where x.organization_id=target.organization_id)
  union all select 'issued_treatment_documents',(select count(*) from public.issued_treatment_documents x,target where x.organization_id=target.organization_id)
  union all select 'treatment_document_events',(select count(*) from public.treatment_document_events x,target where x.organization_id=target.organization_id)
  union all select 'audit_events',(select count(*) from public.audit_events x,target where x.organization_id=target.organization_id)
), states as (
  select 'customers'::text as area,coalesce(c.status,'(null)')::text as state,count(*)::bigint as rows
  from public.customers c,target where c.organization_id=target.organization_id group by c.status
  union all select 'appointments',coalesce(a.status,'(null)'),count(*) from public.appointments a,target where a.organization_id=target.organization_id group by a.status
  union all select 'treatment_records',coalesce(t.status,'(null)'),count(*) from public.treatment_records t,target where t.organization_id=target.organization_id group by t.status
  union all select 'sale_carts',coalesce(c.status,'(null)'),count(*) from public.sale_carts c,target where c.organization_id=target.organization_id group by c.status
  union all select 'appointment_waitlist',coalesce(w.status,'(null)'),count(*) from public.appointment_waitlist w,target where w.organization_id=target.organization_id group by w.status
  union all select 'catalog_purchase_orders',coalesce(o.status,'(null)'),count(*) from public.catalog_purchase_orders o,target where o.organization_id=target.organization_id group by o.status
  union all select 'tasks',coalesce(t.status,'(null)'),count(*) from public.tasks t,target where t.organization_id=target.organization_id group by t.status
  union all select 'documents',coalesce(d.status,'(null)'),count(*) from public.documents d,target where d.organization_id=target.organization_id group by d.status
  union all select 'catalog_products',p.kind||case when p.is_active then ':active' else ':inactive' end,count(*)
  from public.catalog_products p,target where p.organization_id=target.organization_id group by p.kind,p.is_active
  union all select 'catalog_stock',p.kind||':units='||coalesce(sum(p.stock_quantity),0)::text,count(*)
  from public.catalog_products p,target where p.organization_id=target.organization_id group by p.kind
  union all select 'finance',f.transaction_type||case when f.is_archived then ':archived' else ':active' end,count(*)
  from public.finance_transactions f,target where f.organization_id=target.organization_id group by f.transaction_type,f.is_archived
), organization_summary as (
  select o.id,o.name,
    coalesce(array_agg(distinct p.code) filter (where p.code is not null),'{}') as plans,
    coalesce(array_agg(distinct pf.feature_code) filter (where pf.feature_code is not null),'{}') as enabled_features
  from public.organizations o
  left join public.subscriptions s on s.organization_id=o.id and s.status in ('trialing','active') and (s.ends_at is null or s.ends_at>now())
  left join public.plans p on p.id=s.plan_id
  left join public.plan_features pf on pf.plan_id=p.id
  where o.id=(select organization_id from target)
  group by o.id,o.name
)
select 'count'::text as section,c.area as item,jsonb_build_object('rows',c.rows) as details from counts c
union all
select 'state',s.area||' / '||s.state,jsonb_build_object('rows',s.rows) from states s
union all
select 'organization','organization',jsonb_build_object('id',o.id,'name',o.name,'active_plans',o.plans,'enabled_features',o.enabled_features)
from organization_summary o
order by section,item;
