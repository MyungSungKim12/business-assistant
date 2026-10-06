-- SALE-002: immutable visit receipts and an atomic finance ledger entry per receipt.

alter table public.sale_carts drop constraint sale_carts_status_check;
alter table public.sale_carts add constraint sale_carts_status_check
 check(status in ('draft','ready','collecting','paid','void'));

-- Composite keys let the receipt prove that its visit and finance row belong
-- to the same cart and organization, including privileged import paths.
create unique index sale_carts_org_id_visit on public.sale_carts(organization_id,id,visit_id);
create unique index finance_transactions_org_id on public.finance_transactions(organization_id,id);

create table public.visit_payment_receipts (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 cart_id uuid not null,
 visit_id uuid not null,
 operation_id uuid not null,
 method text not null check(method in ('cash','card','transfer')),
 amount numeric(14,0) not null check(amount > 0 and amount < 1000000000000),
 reference text not null default '' check(length(reference) <= 200 and reference=btrim(reference)),
 received_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id),
 finance_transaction_id uuid not null unique,
 foreign key(organization_id,cart_id,visit_id)
  references public.sale_carts(organization_id,id,visit_id),
 foreign key(organization_id,finance_transaction_id)
  references public.finance_transactions(organization_id,id) on delete restrict,
 check(method='cash' or reference<>'')
);
create index visit_payment_receipts_cart_time on public.visit_payment_receipts(cart_id,received_at,id);
create unique index visit_payment_receipts_reference on public.visit_payment_receipts
 (organization_id,method,lower(reference)) where method in ('card','transfer');
create unique index visit_payment_receipts_operation_method on public.visit_payment_receipts
 (organization_id,operation_id,method);

alter table public.visit_payment_receipts enable row level security;
create policy visit_payment_receipts_member_select on public.visit_payment_receipts
 for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.visit_payment_receipts from public,anon,authenticated;
grant select on public.visit_payment_receipts to authenticated;

create function private.assert_visit_payment_finance_link() returns trigger
language plpgsql set search_path='' as $$
declare finance_row public.finance_transactions%rowtype;
begin
 select * into finance_row from public.finance_transactions
 where id=new.finance_transaction_id for update;
 if not found or finance_row.transaction_type<>'income'
  or finance_row.amount<>new.amount or finance_row.created_by<>new.created_by
  or finance_row.is_archived
 then raise exception 'Inconsistent visit payment finance row' using errcode='P0001'; end if;
 return new;
end $$;
revoke all on function private.assert_visit_payment_finance_link() from public,anon,authenticated;
create trigger visit_payment_receipts_finance_link before insert on public.visit_payment_receipts
 for each row execute function private.assert_visit_payment_finance_link();

create function private.prevent_visit_payment_receipt_change() returns trigger
language plpgsql set search_path='' as $$
begin
 raise exception 'Visit payment receipts are immutable' using errcode='P0001';
end $$;
revoke all on function private.prevent_visit_payment_receipt_change() from public,anon,authenticated;
create trigger visit_payment_receipts_immutable before update or delete on public.visit_payment_receipts
 for each row execute function private.prevent_visit_payment_receipt_change();

create function private.prevent_linked_finance_change() returns trigger
language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.visit_payment_receipts where finance_transaction_id=old.id) then
  raise exception 'Visit payment finance transaction is immutable' using errcode='P0001';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function private.prevent_linked_finance_change() from public,anon,authenticated;
create trigger finance_transactions_payment_immutable before update or delete on public.finance_transactions
 for each row execute function private.prevent_linked_finance_change();

create function private.visit_payment_payload(p_cart_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'visit_id',c.visit_id,'cart_id',c.id,'cart_version',c.version,
  'total_amount',c.total_amount,'paid_amount',coalesce(p.paid_amount,0),
  'outstanding_amount',c.total_amount-coalesce(p.paid_amount,0),
  'currency','KRW','status',c.status,'receipts',coalesce(p.receipts,'[]'::jsonb)
 )
 from public.sale_carts c
 left join lateral (
  select sum(r.amount) paid_amount,
   jsonb_agg(jsonb_build_object('id',r.id,'method',r.method,'amount',r.amount,
    'reference',r.reference,'received_at',r.received_at,'operation_id',r.operation_id)
    order by r.received_at,r.id) receipts
  from public.visit_payment_receipts r where r.cart_id=c.id
 ) p on true
 where c.id=p_cart_id
$$;
revoke all on function private.visit_payment_payload(uuid) from public,anon,authenticated;

create function public.get_visit_payments(p_organization_id uuid,p_visit_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or p_organization_id is null or not private.has_organization_role(
  p_organization_id,array['owner','admin','member']::text[])
 then raise exception 'Visit payment read permission required' using errcode='42501'; end if;
 select private.visit_payment_payload(c.id) into result from public.sale_carts c
 where c.organization_id=p_organization_id and c.visit_id=p_visit_id;
 if result is null then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 return result;
end $$;
revoke all on function public.get_visit_payments(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_visit_payments(uuid,uuid) to authenticated;

create function public.record_visit_payment(
 p_organization_id uuid,p_visit_id uuid,p_expected_version bigint,p_operation_id uuid,
 p_payments jsonb,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare fp text; prior public.sale_cart_operations%rowtype;
 cart_row public.sale_carts%rowtype; visit_row public.customer_visits%rowtype;
 item jsonb; method_value text; amount_value numeric(14,0); reference_value text;
 payment_total numeric(14,0):=0; already_paid numeric(14,0); finance_id uuid; result jsonb;
 seen_methods text[]:=array[]::text[];
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_visit_id is null or p_expected_version is null or p_expected_version<1
  or p_operation_id is null or p_confirmed is distinct from true
  or p_payments is null or jsonb_typeof(p_payments)<>'array'
  or jsonb_array_length(p_payments) not between 1 and 3
 then raise exception 'Invalid payment request' using errcode='22023'; end if;

 for item in select value from jsonb_array_elements(p_payments) as elements(value) loop
  if jsonb_typeof(item)<>'object' or not(item ?& array['method','amount','reference'])
   or item - array['method','amount','reference'] <> '{}'::jsonb
   or jsonb_typeof(item->'method')<>'string' or jsonb_typeof(item->'amount')<>'string'
   or jsonb_typeof(item->'reference')<>'string'
  then raise exception 'Invalid payment item' using errcode='22023'; end if;
  method_value=item->>'method';
  if method_value not in ('cash','card','transfer') or method_value=any(seen_methods)
   or (item->>'amount') !~ '^[1-9][0-9]{0,11}$'
   or length(item->>'reference')>200
   or (method_value in ('card','transfer') and btrim(item->>'reference')='')
  then raise exception 'Invalid payment item' using errcode='22023'; end if;
  seen_methods=array_append(seen_methods,method_value);
  amount_value=(item->>'amount')::numeric(14,0);
  payment_total=payment_total+amount_value;
  if payment_total>=1000000000000 then raise exception 'Invalid payment amount' using errcode='22023'; end if;
 end loop;

 fp=md5(jsonb_build_object('visit_id',p_visit_id,'version',p_expected_version,
  'payments',p_payments,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('sale-cart:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.sale_cart_operations
 where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.action<>'record_payment' or prior.request_fingerprint<>fp
  then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;

 select * into cart_row from public.sale_carts
 where organization_id=p_organization_id and visit_id=p_visit_id for update;
 if not found then raise exception 'Visit cart not found' using errcode='P0002'; end if;
 select * into visit_row from public.customer_visits
 where organization_id=p_organization_id and id=p_visit_id for update;
 if cart_row.version<>p_expected_version or cart_row.status not in ('ready','collecting')
  or visit_row.status<>'checkout_ready'
 then raise exception 'Cart changed' using errcode='P0001'; end if;
 if cart_row.total_amount<=0 or cart_row.total_amount<>trunc(cart_row.total_amount)
 then raise exception 'Cart amount must be whole KRW' using errcode='22023'; end if;
 select coalesce(sum(amount),0) into already_paid
 from public.visit_payment_receipts where cart_id=cart_row.id;
 if already_paid+payment_total>cart_row.total_amount
 then raise exception 'Payment exceeds outstanding amount' using errcode='22023'; end if;

 for item in select value from jsonb_array_elements(p_payments) as elements(value) loop
  method_value=item->>'method';amount_value=(item->>'amount')::numeric(14,0);
  reference_value=btrim(item->>'reference');
  insert into public.finance_transactions(organization_id,transaction_type,amount,
   transaction_date,category,counterparty,memo,is_archived,created_by)
  values(p_organization_id,'income',amount_value,(now() at time zone 'Asia/Seoul')::date,'Visit payment','',
   'Visit '||p_visit_id::text,false,auth.uid()) returning id into finance_id;
  insert into public.visit_payment_receipts(organization_id,cart_id,visit_id,operation_id,
   method,amount,reference,created_by,finance_transaction_id)
  values(p_organization_id,cart_row.id,p_visit_id,p_operation_id,method_value,
   amount_value,reference_value,auth.uid(),finance_id);
 end loop;

 update public.sale_carts set status=case when already_paid+payment_total=total_amount then 'paid' else 'collecting' end,
  version=version+1,updated_by=auth.uid(),updated_at=now() where id=cart_row.id;
 if already_paid+payment_total=cart_row.total_amount then
  update public.customer_visits set status='closed',closed_at=now(),version=version+1,
   updated_by=auth.uid(),updated_at=now() where id=p_visit_id;
 end if;
 result=private.visit_payment_payload(cart_row.id);
 insert into public.sale_cart_operations(organization_id,operation_id,actor_id,action,
  request_fingerprint,result_snapshot)
 values(p_organization_id,p_operation_id,auth.uid(),'record_payment',fp,result);
 return result;
end $$;
revoke all on function public.record_visit_payment(uuid,uuid,bigint,uuid,jsonb,boolean)
 from public,anon,authenticated;
grant execute on function public.record_visit_payment(uuid,uuid,bigint,uuid,jsonb,boolean)
 to authenticated;
