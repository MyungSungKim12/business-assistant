-- WAL-11: record completed partial refunds for exact-value cash wallets.
begin;

alter table public.customer_wallets
 add column if not exists wallet_balance_version bigint not null default 1 check(wallet_balance_version>0);
alter table public.customer_wallets drop constraint if exists customer_wallets_lifecycle_status_check;
alter table public.customer_wallets add constraint customer_wallets_lifecycle_status_check
 check(lifecycle_status in ('active','paused','refunded'));

create table if not exists public.wallet_purchase_refund_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, wallet_id uuid not null,
 customer_id uuid not null, sale_line_id uuid not null, cart_id uuid not null,
 amount numeric(14,0) not null check(amount>0 and amount<1000000000000),
 previous_balance numeric(12,0) not null check(previous_balance>=amount),
 new_balance numeric(12,0) not null check(new_balance=previous_balance-amount),
 balance_version bigint not null check(balance_version>1),
 transaction_date date not null, reason text not null check(length(btrim(reason)) between 1 and 1000),
 finance_transaction_id uuid not null unique references public.finance_transactions(id),
 operation_id uuid not null, request_fingerprint text not null, result_snapshot jsonb not null,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,operation_id),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 foreign key(organization_id,customer_id) references public.customers(organization_id,id),
 foreign key(organization_id,sale_line_id) references public.sale_cart_lines(organization_id,id),
 foreign key(organization_id,cart_id) references public.sale_carts(organization_id,id)
);
create index if not exists wallet_purchase_refund_wallet_time on public.wallet_purchase_refund_events(organization_id,wallet_id,created_at desc);
alter table public.wallet_purchase_refund_events enable row level security;
drop policy if exists wallet_purchase_refund_member_read on public.wallet_purchase_refund_events;
create policy wallet_purchase_refund_member_read on public.wallet_purchase_refund_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.wallet_purchase_refund_events from public,anon,authenticated;
grant select on public.wallet_purchase_refund_events to authenticated;
drop trigger if exists immutable on public.wallet_purchase_refund_events;
create trigger immutable before update or delete on public.wallet_purchase_refund_events
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.prevent_linked_finance_change()
returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.visit_payment_receipts where finance_transaction_id=old.id)
  or exists(select 1 from public.visit_payment_refunds where finance_transaction_id=old.id)
  or exists(select 1 from public.wallet_purchase_refund_events where finance_transaction_id=old.id)
 then raise exception 'Linked finance transaction is immutable' using errcode='P0001'; end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function private.prevent_linked_finance_change() from public,anon,authenticated;

create or replace function private.version_wallet_balance()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.money_balance is distinct from old.money_balance or new.count_balance is distinct from old.count_balance
  or new.lifecycle_status is distinct from old.lifecycle_status or new.expires_on is distinct from old.expires_on
  or new.customer_id is distinct from old.customer_id then
  new.wallet_balance_version=old.wallet_balance_version+1;
 end if;
 return new;
end $$;
revoke all on function private.version_wallet_balance() from public,anon,authenticated;
drop trigger if exists wallet_balance_version on public.customer_wallets;
create trigger wallet_balance_version before update on public.customer_wallets
 for each row execute function private.version_wallet_balance();

create or replace function private.prevent_paused_wallet_usage()
returns trigger language plpgsql security definer set search_path='' as $$
declare state text;
begin
 select lifecycle_status into state from public.customer_wallets where id=new.wallet_id and organization_id=new.organization_id;
 if state='paused' then raise exception 'Wallet is paused' using errcode='P0001'; end if;
 if state='refunded' then raise exception 'Wallet is refunded' using errcode='P0001'; end if;
 return new;
end $$;
revoke all on function private.prevent_paused_wallet_usage() from public,anon,authenticated;

create or replace function private.prevent_refunded_wallet_change()
returns trigger language plpgsql set search_path='' as $$
begin
 if old.lifecycle_status='refunded' then raise exception 'Refunded wallet is closed' using errcode='P0001'; end if;
 return new;
end $$;
revoke all on function private.prevent_refunded_wallet_change() from public,anon,authenticated;
drop trigger if exists refunded_wallet_closed on public.customer_wallets;
create trigger refunded_wallet_closed before update on public.customer_wallets
 for each row execute function private.prevent_refunded_wallet_change();

create or replace function private.wallet_cash_refund_cap(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w public.customer_wallets%rowtype; issue public.wallet_issuance_ledger%rowtype;
 line public.sale_cart_lines%rowtype; cart public.sale_carts%rowtype; sold numeric(14,0); refunded numeric(14,0); cap numeric(14,0);
begin
 select * into w from public.customer_wallets where organization_id=p_organization_id and customer_id=p_customer_id and id=p_wallet_id;
 if not found then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if w.lifecycle_status<>'active' or (w.expires_on is not null and w.expires_on<(now() at time zone 'Asia/Seoul')::date)
  or w.valid_from>(now() at time zone 'Asia/Seoul')::date or w.count_balance<>0 then
  raise exception 'Wallet refund requires an active, unexpired money-only wallet' using errcode='P0001';
 end if;
 select * into issue from public.wallet_issuance_ledger where organization_id=p_organization_id and wallet_id=w.id;
 select * into line from public.sale_cart_lines where organization_id=p_organization_id and id=w.sale_line_id;
 select * into cart from public.sale_carts where organization_id=p_organization_id and id=line.cart_id;
 if issue.wallet_id is null or line.id is null or line.source_type<>'membership' or cart.status<>'paid'
  or issue.count_amount<>0 or issue.money_amount<>w.money_balance+coalesce((select sum(e.amount) from public.wallet_purchase_refund_events e where e.organization_id=p_organization_id and e.wallet_id=w.id),0)
 then raise exception 'Wallet is not eligible for cash refund' using errcode='P0001'; end if;
 sold=greatest(0,line.line_total-private.sale_cart_line_discount(cart.id,line.id));
 if sold<>issue.money_amount then raise exception 'Discounted sale value differs from issued cash benefit' using errcode='P0001'; end if;
 select coalesce(sum(amount),0) into refunded from public.wallet_purchase_refund_events where organization_id=p_organization_id and wallet_id=w.id;
 cap=least(w.money_balance,greatest(0,sold-refunded));
 return jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'wallet_id',w.id,
  'refund_cap',cap::text,'money_balance',w.money_balance::text,'balance_version',w.wallet_balance_version,
  'purchase_amount',sold::text,'currency','KRW');
end $$;
revoke all on function private.wallet_cash_refund_cap(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.preview_wallet_purchase_refund(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then
  raise exception 'Organization manager required' using errcode='42501'; end if;
 return private.wallet_cash_refund_cap(p_organization_id,p_customer_id,p_wallet_id);
end $$;
revoke all on function public.preview_wallet_purchase_refund(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.preview_wallet_purchase_refund(uuid,uuid,uuid) to authenticated;

create or replace function public.refund_wallet_purchase(
 p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid,p_amount text,p_reason text,
 p_expected_balance_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.customer_wallets%rowtype; prior public.wallet_purchase_refund_events%rowtype;
 fp text; amount_value numeric(14,0); cap jsonb; finance_id uuid; result jsonb; next_balance numeric(12,0); today date:=(now() at time zone 'Asia/Seoul')::date;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_customer_id is null or p_wallet_id is null or p_operation_id is null or p_expected_balance_version is null or p_expected_balance_version<1
  or p_amount is null or p_amount!~'^[1-9][0-9]{0,11}$' or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
  or p_confirmed is distinct from true then raise exception 'Invalid wallet refund request' using errcode='22023'; end if;
 amount_value=p_amount::numeric(14,0);
 fp=md5(jsonb_build_object('customer',p_customer_id,'wallet',p_wallet_id,'amount',p_amount,'reason',btrim(p_reason),'version',p_expected_balance_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('wallet-refund:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.wallet_purchase_refund_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.created_by<>auth.uid() or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into w from public.customer_wallets where organization_id=p_organization_id and customer_id=p_customer_id and id=p_wallet_id for update;
 if not found then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if w.wallet_balance_version<>p_expected_balance_version then raise exception 'Wallet balance changed' using errcode='P0001'; end if;
 cap=private.wallet_cash_refund_cap(p_organization_id,p_customer_id,p_wallet_id);
 if amount_value>(cap->>'refund_cap')::numeric then raise exception 'Refund exceeds eligible remaining amount' using errcode='22023'; end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and s.from_date<=today and s.to_date>=today) then
  raise exception 'Refund date overlaps a confirmed commission settlement' using errcode='P0001'; end if;
 next_balance=w.money_balance-amount_value;
 insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
 values(p_organization_id,'expense',amount_value,today,'Membership refund','','회원권 부분 환불 · '||p_wallet_id::text,false,auth.uid()) returning id into finance_id;
 update public.customer_wallets set money_balance=next_balance,lifecycle_status=case when next_balance=0 then 'refunded' else 'active' end
 where organization_id=p_organization_id and id=p_wallet_id returning * into w;
 result=jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'wallet_id',p_wallet_id,
  'amount',amount_value::text,'previous_balance',(next_balance+amount_value)::text,'new_balance',next_balance::text,
  'balance_version',w.wallet_balance_version,'transaction_date',today,'finance_transaction_id',finance_id,
  'reason',btrim(p_reason),'lifecycle_status',w.lifecycle_status,'created_by',auth.uid());
 insert into public.wallet_purchase_refund_events(organization_id,wallet_id,customer_id,sale_line_id,cart_id,amount,previous_balance,new_balance,
  balance_version,transaction_date,reason,finance_transaction_id,operation_id,request_fingerprint,result_snapshot,created_by)
 select p_organization_id,w.id,p_customer_id,w.sale_line_id,l.cart_id,amount_value,next_balance+amount_value,next_balance,
  w.wallet_balance_version,today,btrim(p_reason),finance_id,p_operation_id,fp,result,auth.uid()
 from public.sale_cart_lines l where l.organization_id=p_organization_id and l.id=w.sale_line_id;
 return result;
end $$;
revoke all on function public.refund_wallet_purchase(uuid,uuid,uuid,text,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.refund_wallet_purchase(uuid,uuid,uuid,text,text,bigint,uuid,boolean) to authenticated;

-- Preserve existing history and append immutable cash-refund events.
do $$ begin
 if to_regprocedure('public.list_wallet_history_before_refund(uuid,uuid,uuid)') is null then
  alter function public.list_wallet_history(uuid,uuid,uuid) rename to list_wallet_history_before_refund;
 end if;
end $$;
create or replace function public.list_wallet_history(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare prior jsonb; appended jsonb;
begin
 prior=public.list_wallet_history_before_refund(p_organization_id,p_customer_id,p_wallet_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'event_type','refund','occurred_at',e.created_at,
  'money_delta',(-e.amount)::text,'count_delta',0,'reason',e.reason,'visit_id',null,
  'previous_expires_on',null,'expires_on',null) order by e.created_at desc,e.id desc),'[]'::jsonb)
 into appended from public.wallet_purchase_refund_events e
 where e.organization_id=p_organization_id and e.customer_id=p_customer_id and e.wallet_id=p_wallet_id;
 return (select coalesce(jsonb_agg(value order by value->>'occurred_at' desc,value->>'id' desc),'[]'::jsonb)
  from jsonb_array_elements(coalesce(prior,'[]'::jsonb)||appended));
end $$;
revoke all on function public.list_wallet_history_before_refund(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_wallet_history(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_wallet_history(uuid,uuid,uuid) to authenticated;

-- Add each wallet refund to the refund-date commission batch as a negative membership line.
do $$ begin
 if to_regprocedure('private.staff_commission_preview_before_wallet_refunds(uuid,date,date)') is null then
  alter function private.staff_commission_preview(uuid,date,date) rename to staff_commission_preview_before_wallet_refunds;
 end if;
end $$;
create or replace function private.staff_commission_preview(p_organization_id uuid,p_from date,p_to date) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(private.staff_commission_preview_before_wallet_refunds(p_organization_id,p_from,p_to),'[]'::jsonb)
  || coalesce((
   select jsonb_agg(jsonb_build_object('source_event_id',e.id,'source_event_date',e.transaction_date,'event_kind','refund',
    'sale_line_id',l.id,'staff_id',s.id,'staff_name_snapshot',coalesce(s.name,nullif(l.staff_name_snapshot,''),'미지정'),
    'commission_scope','membership','source_id',l.source_id,'rule_id',r.id,'rule_rate_basis_points',r.rate_basis_points,
    'rule_snapshot',jsonb_build_object('effective_from',r.effective_from,'effective_to',r.effective_to,'basis','net_paid','adjustment','wallet_refund'),
    'net_paid_amount',(-e.amount)::text,'commission_amount',case when r.id is null then '0' else round(-e.amount*r.rate_basis_points/10000.0,0)::text end,
    'warning',case when s.id is null then '담당 직원 미지정' when r.id is null then '환불일 적용 수당 규칙 없음' else null end)
    order by s.name,l.id,e.created_at,e.id)
   from public.wallet_purchase_refund_events e
   join public.sale_cart_lines l on l.organization_id=e.organization_id and l.id=e.sale_line_id
   left join public.appointment_staff s on s.organization_id=l.organization_id and (s.id=l.staff_id or s.auth_user_id=l.staff_id)
   left join lateral (select cr.* from public.staff_commission_rules cr where cr.organization_id=e.organization_id
    and cr.commission_scope='membership' and (cr.staff_id is null or cr.staff_id=s.id) and cr.product_id=l.source_id
    and cr.effective_from<=e.transaction_date and (cr.effective_to is null or cr.effective_to>=e.transaction_date)
    order by (cr.staff_id is not null) desc,cr.effective_from desc,cr.created_at desc,cr.id limit 1) r on true
   where e.organization_id=p_organization_id and e.transaction_date between p_from and p_to
  ),'[]'::jsonb)
$$;
revoke all on function private.staff_commission_preview_before_wallet_refunds(uuid,date,date) from public,anon,authenticated;
revoke all on function private.staff_commission_preview(uuid,date,date) from public,anon,authenticated;

commit;
