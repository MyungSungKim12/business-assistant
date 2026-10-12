-- WAL-003: audited pause/resume/extension without rewriting benefit balances.
begin;

alter table public.customer_wallets
 add column if not exists lifecycle_status text not null default 'active'
  check(lifecycle_status in ('active','paused')),
 add column if not exists paused_on date,
 add column if not exists lifecycle_version bigint not null default 1 check(lifecycle_version>0);
alter table public.customer_wallets drop constraint if exists wallet_pause_consistency;
alter table public.customer_wallets add constraint wallet_pause_consistency
 check((lifecycle_status='paused')=(paused_on is not null));

create table if not exists public.wallet_lifecycle_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 wallet_id uuid not null,
 action text not null check(action in ('pause','resume','extend')),
 previous_expires_on date,
 expires_on date,
 previous_status text not null,
 lifecycle_version bigint not null check(lifecycle_version>1),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 operation_id uuid not null,
 request_fingerprint text not null,
 result_snapshot jsonb not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 foreign key(organization_id,wallet_id) references public.customer_wallets(organization_id,id),
 unique(organization_id,operation_id),
 unique(organization_id,wallet_id,lifecycle_version)
);
alter table public.wallet_lifecycle_events enable row level security;
drop policy if exists wallet_lifecycle_read on public.wallet_lifecycle_events;
create policy wallet_lifecycle_read on public.wallet_lifecycle_events for select to authenticated
 using ((select private.has_organization_role(organization_id,array['owner','admin','member']::text[])));
revoke all on public.wallet_lifecycle_events from public,anon,authenticated;
grant select on public.wallet_lifecycle_events to authenticated;
drop trigger if exists immutable on public.wallet_lifecycle_events;
create trigger immutable before update or delete on public.wallet_lifecycle_events
 for each row execute function private.prevent_catalog_ledger_change();

create or replace function private.prevent_paused_wallet_usage()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.customer_wallets where id=new.wallet_id and organization_id=new.organization_id
  and lifecycle_status='paused') then
  raise exception 'Wallet is paused' using errcode='P0001';
 end if;
 return new;
end $$;
revoke all on function private.prevent_paused_wallet_usage() from public,anon,authenticated;
drop trigger if exists wallet_usage_active on public.wallet_usage_ledger;
create trigger wallet_usage_active before insert on public.wallet_usage_ledger
 for each row execute function private.prevent_paused_wallet_usage();

create or replace function public.manage_customer_wallet(
 p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid,p_action text,p_extend_days int,
 p_reason text,p_expected_version bigint,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.customer_wallets%rowtype; prior public.wallet_lifecycle_events%rowtype;
 fp text; today date := (now() at time zone 'Asia/Seoul')::date;
 result jsonb; previous_expiry date; previous_status text;
begin
 perform private.assert_sale_cart_manager(p_organization_id);
 if p_customer_id is null or p_wallet_id is null or p_operation_id is null or p_expected_version is null
  or p_expected_version<1 or p_action is null or p_action not in ('pause','resume','extend')
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
  or (p_action='extend' and (p_extend_days is null or p_extend_days not between 1 and 3650))
  or (p_action<>'extend' and p_extend_days is not null) then
  raise exception 'Invalid wallet lifecycle request' using errcode='22023'; end if;
 fp=md5(jsonb_build_object('customer',p_customer_id,'wallet',p_wallet_id,'action',p_action,
  'days',p_extend_days,'reason',btrim(p_reason),'version',p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('wallet-lifecycle:'||p_organization_id::text||p_operation_id::text,0));
 select * into prior from public.wallet_lifecycle_events where organization_id=p_organization_id and operation_id=p_operation_id;
 if found then
  if prior.created_by<>auth.uid() or prior.request_fingerprint<>fp then
   raise exception 'Operation conflict' using errcode='P0001'; end if;
  return prior.result_snapshot;
 end if;
 select * into w from public.customer_wallets where organization_id=p_organization_id
  and customer_id=p_customer_id and id=p_wallet_id for update;
 if not found then raise exception 'Wallet not found' using errcode='P0002'; end if;
 if w.lifecycle_version<>p_expected_version then raise exception 'Wallet changed' using errcode='P0001'; end if;
 if (p_action='pause' and w.lifecycle_status<>'active')
  or (p_action='resume' and w.lifecycle_status<>'paused')
  or (p_action='extend' and w.expires_on is null) then
  raise exception 'Wallet state conflict' using errcode='P0001'; end if;
 previous_expiry=w.expires_on;
 previous_status=w.lifecycle_status;
 if p_action='pause' then
  update public.customer_wallets set lifecycle_status='paused',paused_on=today,lifecycle_version=lifecycle_version+1
  where id=w.id;
 elsif p_action='resume' then
  update public.customer_wallets set lifecycle_status='active',paused_on=null,
   expires_on=case when expires_on is null then null else expires_on+(today-w.paused_on) end,
   lifecycle_version=lifecycle_version+1 where id=w.id;
 else
  update public.customer_wallets set expires_on=expires_on+p_extend_days,
   lifecycle_version=lifecycle_version+1 where id=w.id;
 end if;
 select * into w from public.customer_wallets where id=w.id;
 result=to_jsonb(w)||jsonb_build_object('money_balance',w.money_balance::text);
 insert into public.wallet_lifecycle_events(organization_id,wallet_id,action,previous_expires_on,
  expires_on,previous_status,lifecycle_version,reason,operation_id,request_fingerprint,result_snapshot,created_by)
 values(p_organization_id,w.id,p_action,previous_expiry,w.expires_on,previous_status,
  w.lifecycle_version,btrim(p_reason),p_operation_id,fp,result,auth.uid());
 return result;
end $$;
revoke all on function public.manage_customer_wallet(uuid,uuid,uuid,text,int,text,bigint,uuid) from public,anon;
grant execute on function public.manage_customer_wallet(uuid,uuid,uuid,text,int,text,bigint,uuid) to authenticated;

commit;
