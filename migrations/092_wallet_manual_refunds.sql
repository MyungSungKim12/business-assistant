-- WAL-11: distinguish external cash refunds from revoked wallet benefits.
begin;

alter table public.wallet_purchase_refund_events
 add column if not exists cash_refund_amount numeric(14,0) not null default 0 check(cash_refund_amount>=0),
 add column if not exists money_removed numeric(12,0) not null default 0 check(money_removed>=0),
 add column if not exists count_removed integer not null default 0 check(count_removed>=0),
 add column if not exists previous_count_balance integer not null default 0 check(previous_count_balance>=0),
 add column if not exists new_count_balance integer not null default 0 check(new_count_balance>=0);
drop trigger if exists immutable on public.wallet_purchase_refund_events;
update public.wallet_purchase_refund_events set cash_refund_amount=amount where cash_refund_amount=0;
update public.wallet_purchase_refund_events set money_removed=amount where money_removed=0;
create trigger immutable before update or delete on public.wallet_purchase_refund_events for each row execute function private.prevent_catalog_ledger_change();
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.wallet_purchase_refund_events'::regclass and contype='c'
  and (pg_get_constraintdef(oid) ilike '%previous_balance%amount%' or pg_get_constraintdef(oid) ilike '%new_balance%previous_balance%amount%')
 loop execute format('alter table public.wallet_purchase_refund_events drop constraint %I',c.conname); end loop;
end $$;

create or replace function private.wallet_refund_event_defaults() returns trigger language plpgsql set search_path='' as $$
declare w public.customer_wallets%rowtype;
begin
 if new.cash_refund_amount=0 then new.cash_refund_amount=new.amount;end if;
 if new.money_removed=0 and new.count_removed=0 then
  new.money_removed=new.amount;
  select * into w from public.customer_wallets where organization_id=new.organization_id and id=new.wallet_id;
  new.previous_count_balance=w.count_balance; new.new_count_balance=w.count_balance;
 end if;
 return new;
end $$;
revoke all on function private.wallet_refund_event_defaults() from public,anon,authenticated;
drop trigger if exists wallet_refund_event_defaults on public.wallet_purchase_refund_events;
create trigger wallet_refund_event_defaults before insert on public.wallet_purchase_refund_events for each row execute function private.wallet_refund_event_defaults();

create or replace function private.wallet_manual_refund_preview(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w public.customer_wallets%rowtype; issue public.wallet_issuance_ledger%rowtype; line public.sale_cart_lines%rowtype; cart public.sale_carts%rowtype; sold numeric(14,0); refunded numeric(14,0);
begin
 select * into w from public.customer_wallets where organization_id=p_organization_id and customer_id=p_customer_id and id=p_wallet_id;
 if not found then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if w.lifecycle_status<>'active' or (w.expires_on is not null and w.expires_on<(now() at time zone 'Asia/Seoul')::date) or w.valid_from>(now() at time zone 'Asia/Seoul')::date then
  raise exception 'Wallet refund requires an active, unexpired wallet' using errcode='P0001'; end if;
 select * into issue from public.wallet_issuance_ledger where organization_id=p_organization_id and wallet_id=w.id;
 select * into line from public.sale_cart_lines where organization_id=p_organization_id and id=w.sale_line_id;
 select * into cart from public.sale_carts where organization_id=p_organization_id and id=line.cart_id;
 if issue.wallet_id is null or line.id is null or line.source_type<>'membership' or cart.status<>'paid'
  or issue.count_amount<w.count_balance+coalesce((select sum(e.count_removed) from public.wallet_purchase_refund_events e where e.organization_id=p_organization_id and e.wallet_id=w.id),0)
  or issue.money_amount<w.money_balance+coalesce((select sum(e.money_removed) from public.wallet_purchase_refund_events e where e.organization_id=p_organization_id and e.wallet_id=w.id),0)
 then raise exception 'Wallet is not eligible for refund' using errcode='P0001'; end if;
 sold=greatest(0,line.line_total-private.sale_cart_line_discount(cart.id,line.id));
 select coalesce(sum(cash_refund_amount),0) into refunded from public.wallet_purchase_refund_events where organization_id=p_organization_id and wallet_id=w.id;
 return jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'wallet_id',w.id,
  'refund_cap',greatest(0,sold-refunded)::text,'money_balance',w.money_balance::text,'count_balance',w.count_balance,
  'balance_version',w.wallet_balance_version,'purchase_amount',sold::text,'currency','KRW');
end $$;
revoke all on function private.wallet_manual_refund_preview(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.preview_wallet_purchase_refund_benefits(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin']::text[]) then raise exception 'Organization manager required' using errcode='42501'; end if;
 return private.wallet_manual_refund_preview(p_organization_id,p_customer_id,p_wallet_id);
end $$;
revoke all on function public.preview_wallet_purchase_refund_benefits(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.preview_wallet_purchase_refund_benefits(uuid,uuid,uuid) to authenticated;

create or replace function public.refund_wallet_purchase_benefits(
 p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid,p_cash_refund_amount text,p_remove_money_amount text,p_remove_count_amount integer,
 p_reason text,p_expected_balance_version bigint,p_operation_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.customer_wallets%rowtype; prior public.wallet_purchase_refund_events%rowtype; fp text; cash_value numeric(14,0); money_value numeric(12,0); cap jsonb;
 finance_id uuid; result jsonb; next_money numeric(12,0); next_count integer; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_customer_id is null or p_wallet_id is null or p_operation_id is null or p_expected_balance_version is null or p_expected_balance_version<1
  or p_cash_refund_amount is null or p_cash_refund_amount!~'^[1-9][0-9]{0,11}$' or p_remove_money_amount is null or p_remove_money_amount!~'^(0|[1-9][0-9]{0,11})$'
  or p_remove_count_amount is null or p_remove_count_amount<0 or p_remove_count_amount>1000000
  or (p_remove_money_amount='0' and p_remove_count_amount=0) or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_confirmed is distinct from true
 then raise exception 'Invalid wallet refund request' using errcode='22023'; end if;
 cash_value=p_cash_refund_amount::numeric(14,0);money_value=p_remove_money_amount::numeric(12,0);
 fp=md5(jsonb_build_object('customer',p_customer_id,'wallet',p_wallet_id,'cash',p_cash_refund_amount,'money_removed',p_remove_money_amount,'count_removed',p_remove_count_amount,'reason',btrim(p_reason),'version',p_expected_balance_version,'confirmed',p_confirmed)::text);
 perform pg_advisory_xact_lock(hashtextextended('wallet-refund:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.wallet_purchase_refund_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then if prior.created_by<>auth.uid() or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;return prior.result_snapshot;end if;
 select * into w from public.customer_wallets where organization_id=p_organization_id and customer_id=p_customer_id and id=p_wallet_id for update;
 if not found then raise exception 'Wallet not found' using errcode='P0002';end if;
 if w.wallet_balance_version<>p_expected_balance_version then raise exception 'Wallet balance changed' using errcode='P0001';end if;
 cap=private.wallet_manual_refund_preview(p_organization_id,p_customer_id,p_wallet_id);
 if cash_value>(cap->>'refund_cap')::numeric or money_value>w.money_balance or p_remove_count_amount>w.count_balance then raise exception 'Refund or benefit removal exceeds available balance' using errcode='22023';end if;
 if exists(select 1 from public.staff_commission_settlements s where s.organization_id=p_organization_id and s.from_date<=today and s.to_date>=today) then raise exception 'Refund date overlaps a confirmed commission settlement' using errcode='P0001';end if;
 next_money=w.money_balance-money_value;next_count=w.count_balance-p_remove_count_amount;
 insert into public.finance_transactions(organization_id,transaction_type,amount,transaction_date,category,counterparty,memo,is_archived,created_by)
 values(p_organization_id,'expense',cash_value,today,'Membership refund','','회원권 환불 · '||p_wallet_id::text,false,auth.uid()) returning id into finance_id;
 update public.customer_wallets set money_balance=next_money,count_balance=next_count,
  lifecycle_status=case when next_money=0 and next_count=0 then 'refunded' else 'active' end
 where organization_id=p_organization_id and id=p_wallet_id returning * into w;
 result=jsonb_build_object('organization_id',p_organization_id,'customer_id',p_customer_id,'wallet_id',p_wallet_id,
  'amount',cash_value::text,'money_removed',money_value::text,'count_removed',p_remove_count_amount,
  'previous_balance',(next_money+money_value)::text,'new_balance',next_money::text,'previous_count_balance',next_count+p_remove_count_amount,'new_count_balance',next_count,
  'balance_version',w.wallet_balance_version,'transaction_date',today,'finance_transaction_id',finance_id,'reason',btrim(p_reason),'lifecycle_status',w.lifecycle_status,'created_by',auth.uid());
 insert into public.wallet_purchase_refund_events(organization_id,wallet_id,customer_id,sale_line_id,cart_id,amount,previous_balance,new_balance,money_removed,count_removed,previous_count_balance,new_count_balance,
  balance_version,transaction_date,reason,finance_transaction_id,operation_id,request_fingerprint,result_snapshot,created_by)
 select p_organization_id,w.id,p_customer_id,w.sale_line_id,l.cart_id,cash_value,next_money+money_value,next_money,money_value,p_remove_count_amount,next_count+p_remove_count_amount,next_count,
  w.wallet_balance_version,today,btrim(p_reason),finance_id,p_operation_id,fp,result,auth.uid()
 from public.sale_cart_lines l where l.organization_id=p_organization_id and l.id=w.sale_line_id;
 return result;
end $$;
revoke all on function public.refund_wallet_purchase_benefits(uuid,uuid,uuid,text,text,integer,text,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.refund_wallet_purchase_benefits(uuid,uuid,uuid,text,text,integer,text,bigint,uuid,boolean) to authenticated;

-- Preserve the existing history endpoint and add separate money/count benefit deltas.
do $$ begin if to_regprocedure('public.list_wallet_history_before_manual_refunds(uuid,uuid,uuid)') is null then alter function public.list_wallet_history(uuid,uuid,uuid) rename to list_wallet_history_before_manual_refunds;end if;end $$;
create or replace function public.list_wallet_history(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare prior jsonb; appended jsonb;
begin
 prior=public.list_wallet_history_before_refund(p_organization_id,p_customer_id,p_wallet_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'event_type','refund','occurred_at',e.created_at,'money_delta',(-e.money_removed)::text,'count_delta',-e.count_removed,'reason',e.reason,'visit_id',null,'previous_expires_on',null,'expires_on',null) order by e.created_at desc,e.id desc),'[]'::jsonb)
 into appended from public.wallet_purchase_refund_events e where e.organization_id=p_organization_id and e.customer_id=p_customer_id and e.wallet_id=p_wallet_id;
 return (select coalesce(jsonb_agg(value order by value->>'occurred_at' desc,value->>'id' desc),'[]'::jsonb) from jsonb_array_elements(coalesce(prior,'[]'::jsonb)||appended));
end $$;
revoke all on function public.list_wallet_history_before_manual_refunds(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_wallet_history(uuid,uuid,uuid) from public,anon,authenticated;grant execute on function public.list_wallet_history(uuid,uuid,uuid) to authenticated;

commit;

