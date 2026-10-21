-- WAL-11: transfer only untouched memberships; keep the original sale and benefit ledger intact.
begin;

alter table public.customer_wallets add column if not exists owner_version bigint not null default 1 check(owner_version>0);
create table if not exists public.wallet_transfer_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, wallet_id uuid not null,
 from_customer_id uuid not null references public.customers(id), to_customer_id uuid not null references public.customers(id),
 owner_version bigint not null check(owner_version>1), reason text not null check(length(btrim(reason)) between 1 and 1000),
 operation_id uuid not null, request_fingerprint text not null, result_snapshot jsonb not null,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 unique(organization_id,operation_id), unique(organization_id,wallet_id,owner_version),
 check(from_customer_id<>to_customer_id)
);
alter table public.wallet_transfer_events enable row level security;
drop policy if exists wallet_transfer_member_read on public.wallet_transfer_events;
create policy wallet_transfer_member_read on public.wallet_transfer_events for select to authenticated
 using((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.wallet_transfer_events from public,anon,authenticated;
grant select on public.wallet_transfer_events to authenticated;
drop trigger if exists immutable on public.wallet_transfer_events;
create trigger immutable before update or delete on public.wallet_transfer_events
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function public.transfer_customer_wallet(
 p_organization_id uuid,p_from_customer_id uuid,p_to_customer_id uuid,p_wallet_id uuid,
 p_expected_owner_version bigint,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare wallet public.customer_wallets%rowtype; issuance public.wallet_issuance_ledger%rowtype;
 prior public.wallet_transfer_events%rowtype; fp text; result jsonb;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_from_customer_id is null or p_to_customer_id is null or p_from_customer_id=p_to_customer_id
  or p_wallet_id is null or p_expected_owner_version is null or p_expected_owner_version<1
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_operation_id is null then
  raise exception 'Invalid wallet transfer request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('from',p_from_customer_id,'to',p_to_customer_id,'wallet',p_wallet_id,
  'version',p_expected_owner_version,'reason',btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('wallet-transfer:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.wallet_transfer_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.created_by<>auth.uid() or prior.request_fingerprint<>fp then raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 if not exists(select 1 from public.customers where organization_id=p_organization_id and id=p_to_customer_id and status not in ('blocked','inactive')) then
  raise exception 'Active customer not found' using errcode='P0002'; end if;
 select * into wallet from public.customer_wallets where organization_id=p_organization_id and customer_id=p_from_customer_id and id=p_wallet_id for update;
 if not found then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if wallet.owner_version<>p_expected_owner_version then raise exception 'Wallet owner changed' using errcode='P0001'; end if;
 if wallet.lifecycle_status<>'active' or exists(select 1 from public.wallet_usage_ledger where organization_id=p_organization_id and wallet_id=wallet.id)
  or exists(select 1 from public.catalog_sale_reversal_ledger where organization_id=p_organization_id and wallet_id=wallet.id) then
  raise exception 'Only unused active membership can be transferred' using errcode='P0001'; end if;
 select * into issuance from public.wallet_issuance_ledger where organization_id=p_organization_id and wallet_id=wallet.id;
 if not found or wallet.money_balance<>issuance.money_amount or wallet.count_balance<>issuance.count_amount then
  raise exception 'Membership balance is not transferable' using errcode='P0001'; end if;
 update public.customer_wallets set customer_id=p_to_customer_id,owner_version=owner_version+1 where organization_id=p_organization_id and id=wallet.id returning * into wallet;
 result=to_jsonb(wallet)||jsonb_build_object('money_balance',wallet.money_balance::text);
 insert into public.wallet_transfer_events(organization_id,wallet_id,from_customer_id,to_customer_id,owner_version,reason,operation_id,request_fingerprint,result_snapshot,created_by)
 values(p_organization_id,wallet.id,p_from_customer_id,p_to_customer_id,wallet.owner_version,btrim(p_reason),p_operation_id,fp,result,auth.uid());
 return result;
end $$;
revoke all on function public.transfer_customer_wallet(uuid,uuid,uuid,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.transfer_customer_wallet(uuid,uuid,uuid,uuid,bigint,text,uuid) to authenticated;

-- Keep transfer visible in the same immutable wallet history returned by the existing API.
create or replace function public.list_wallet_history(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Wallet read permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.customer_wallets where organization_id=p_organization_id and customer_id=p_customer_id and id=p_wallet_id) then
  raise exception 'Wallet not found' using errcode='P0002'; end if;
 return coalesce((select jsonb_agg(h.event order by h.occurred_at desc,h.id desc) from (
  select e.id,e.occurred_at,e.event from (
   select i.id,i.created_at occurred_at,jsonb_build_object('id',i.id,'event_type','issue','occurred_at',i.created_at,'money_delta',i.money_amount::text,'count_delta',i.count_amount,'reason',null,'visit_id',null,'previous_expires_on',null,'expires_on',null) event
    from public.wallet_issuance_ledger i where i.organization_id=p_organization_id and i.wallet_id=p_wallet_id
   union all
   select u.id,u.created_at,jsonb_build_object('id',u.id,'event_type','use','occurred_at',u.created_at,'money_delta',u.money_delta::text,'count_delta',u.count_delta,'reason',null,'visit_id',u.visit_id,'previous_expires_on',null,'expires_on',null)
    from public.wallet_usage_ledger u where u.organization_id=p_organization_id and u.wallet_id=p_wallet_id
   union all
   select r.id,r.created_at,jsonb_build_object('id',r.id,'event_type','use_refund','occurred_at',r.created_at,'money_delta',r.money_delta::text,'count_delta',r.count_delta,'reason',r.reason,'visit_id',r.visit_id,'previous_expires_on',null,'expires_on',null)
    from public.visit_payment_refunds r join public.wallet_usage_ledger u on u.id=r.wallet_usage_id where r.source_kind='wallet_usage' and u.organization_id=p_organization_id and u.wallet_id=p_wallet_id
   union all
   select v.id,v.created_at,jsonb_build_object('id',v.id,'event_type','reversal','occurred_at',v.created_at,'money_delta',(-v.money_amount)::text,'count_delta',-v.count_amount,'reason',null,'visit_id',null,'previous_expires_on',null,'expires_on',null)
    from public.catalog_sale_reversal_ledger v where v.organization_id=p_organization_id and v.kind='membership' and v.wallet_id=p_wallet_id
   union all
   select l.id,l.created_at,jsonb_build_object('id',l.id,'event_type',l.action,'occurred_at',l.created_at,'money_delta','0','count_delta',0,'reason',l.reason,'visit_id',null,'previous_expires_on',l.previous_expires_on,'expires_on',l.expires_on)
    from public.wallet_lifecycle_events l where l.organization_id=p_organization_id and l.wallet_id=p_wallet_id
   union all
   select t.id,t.created_at,jsonb_build_object('id',t.id,'event_type','transfer','occurred_at',t.created_at,'money_delta','0','count_delta',0,'reason',t.reason,'visit_id',null,'previous_expires_on',null,'expires_on',null,'from_customer_id',t.from_customer_id,'to_customer_id',t.to_customer_id)
    from public.wallet_transfer_events t where t.organization_id=p_organization_id and t.wallet_id=p_wallet_id
  ) e order by e.occurred_at desc,e.id desc limit 500
 ) h),'[]'::jsonb);
end $$;
revoke all on function public.list_wallet_history(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_wallet_history(uuid,uuid,uuid) to authenticated;

commit;
