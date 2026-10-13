-- 042: SALE-10 수납·환불 내역 검색, FIN-10 재무 월 마감, HOME-02 전체 미수금 요약.
-- 1) public.list_sale_payments   : 수납(회원권 사용 포함)·환불·반품 내역을 조건으로 검색하고 합계를 함께 돌려준다(조직 구성원 읽기).
-- 2) public.finance_month_closings + close/reopen RPC : 달 단위 마감(owner/admin). 마감된 달의 수입·지출 입력·수정은 트리거가 막는다.
-- 3) public.get_receivables_summary : 조직 전체 미수 방문 수·총액·오래된 미수 상위 N건(조직 구성원 읽기).
-- 033(일 마감: 영업일 시재 마감)과 별개다. 이 마이그레이션은 월 단위 "재무 장부" 마감을 추가한다.
-- 041 다음에 실행한다. 여러 번 실행해도 안전하다. 기존 테이블·함수는 바꾸지 않고 새 트리거만 finance_transactions에 붙인다.
begin;

/* ------------------------------------------------------------------ */
/* FIN-10: 월 마감 테이블                                              */
/* ------------------------------------------------------------------ */
create table if not exists public.finance_month_closings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 month date not null check (month = date_trunc('month', month::timestamp)::date),
 note text not null check (length(btrim(note)) between 1 and 1000),
 closed_by uuid not null references auth.users(id),
 closed_at timestamptz not null default now(),
 reopened_by uuid references auth.users(id),
 reopened_at timestamptz,
 reopen_reason text check (reopen_reason is null or length(btrim(reopen_reason)) between 1 and 1000),
 check ((reopened_at is null) = (reopened_by is null) and (reopened_at is null) = (reopen_reason is null))
);

-- 한 달에 유효(재오픈되지 않은) 마감은 1건만 둔다. 재오픈 후 다시 마감하면 새 행이 생기고 이전 행은 이력으로 남는다.
create unique index if not exists finance_month_closings_active
 on public.finance_month_closings (organization_id, month) where reopened_at is null;
create index if not exists finance_month_closings_org_month
 on public.finance_month_closings (organization_id, month desc, closed_at desc);

alter table public.finance_month_closings enable row level security;
drop policy if exists finance_month_closings_member_select on public.finance_month_closings;
create policy finance_month_closings_member_select on public.finance_month_closings
 for select to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
-- 쓰기는 아래 보안 정의 함수로만 한다.
revoke all on public.finance_month_closings from public, anon, authenticated;
grant select on public.finance_month_closings to authenticated;

-- 마감 행은 지우거나 마감 사실을 바꿀 수 없다. 재오픈 필드만 한 번 채울 수 있다.
create or replace function private.guard_finance_month_closing_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
 if tg_op = 'DELETE' then
  raise exception 'Finance month closings cannot be deleted' using errcode = 'P0001';
 end if;
 if old.reopened_at is not null
  or new.reopened_at is null
  or new.id is distinct from old.id
  or new.organization_id is distinct from old.organization_id
  or new.month is distinct from old.month
  or new.note is distinct from old.note
  or new.closed_by is distinct from old.closed_by
  or new.closed_at is distinct from old.closed_at
 then
  raise exception 'Finance month closings can only be reopened once' using errcode = 'P0001';
 end if;
 return new;
end;
$$;
revoke all on function private.guard_finance_month_closing_change() from public, anon, authenticated;
drop trigger if exists finance_month_closings_guard on public.finance_month_closings;
create trigger finance_month_closings_guard
 before update or delete on public.finance_month_closings
 for each row execute function private.guard_finance_month_closing_change();

/* 같은 (조직, 달)에 대한 마감·재오픈·거래 입력을 직렬화하는 잠금 키 */
create or replace function private.finance_month_lock(p_organization_id uuid, p_month date)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
 select pg_advisory_xact_lock(hashtextextended('finance-month:' || p_organization_id::text || ':' || p_month::text, 0))
$$;
revoke all on function private.finance_month_lock(uuid, date) from public, anon, authenticated;

/* 마감된 달의 거래일로는 입력·수정(보관 포함)을 막는다. 거래일을 옮기는 수정은 이전·이후 달을 모두 확인한다. */
create or replace function private.prevent_closed_finance_month_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
 target_month date;
 months date[];
begin
 if tg_op = 'INSERT' then
  months := array[new.transaction_date];
 else
  months := array[old.transaction_date, new.transaction_date];
 end if;
 -- 달 순서대로 잠가 두 달을 걸치는 수정끼리 교착하지 않게 한다.
 for target_month in
  select distinct date_trunc('month', d::timestamp)::date as m from unnest(months) as d order by m
 loop
  perform private.finance_month_lock(new.organization_id, target_month);
  if exists (
   select 1 from public.finance_month_closings c
   where c.organization_id = new.organization_id and c.month = target_month and c.reopened_at is null
  ) then
   raise exception 'Finance month is closed' using errcode = 'P0001';
  end if;
 end loop;
 return new;
end;
$$;
revoke all on function private.prevent_closed_finance_month_change() from public, anon, authenticated;
drop trigger if exists finance_transactions_month_open on public.finance_transactions;
create trigger finance_transactions_month_open
 before insert or update on public.finance_transactions
 for each row execute function private.prevent_closed_finance_month_change();

create or replace function private.finance_month_closing_payload(p_closing_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
 select jsonb_build_object(
  'id', c.id, 'organization_id', c.organization_id, 'month', c.month, 'note', c.note,
  'closed_by', c.closed_by, 'closed_at', c.closed_at,
  'reopened_by', c.reopened_by, 'reopened_at', c.reopened_at, 'reopen_reason', c.reopen_reason
 )
 from public.finance_month_closings c where c.id = p_closing_id
$$;
revoke all on function private.finance_month_closing_payload(uuid) from public, anon, authenticated;

create or replace function public.close_finance_month(p_organization_id uuid, p_month date, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
 closing_id uuid;
begin
 if auth.uid() is null or p_organization_id is null
  or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[])
 then raise exception 'Finance month close permission required' using errcode = '42501'; end if;
 if p_month is null or p_month <> date_trunc('month', p_month::timestamp)::date
  or p_month > date_trunc('month', (now() at time zone 'Asia/Seoul'))::date
  or p_note is null or length(btrim(p_note)) not between 1 and 1000
 then raise exception 'Invalid finance month close' using errcode = '22023'; end if;
 perform private.finance_month_lock(p_organization_id, p_month);
 if exists (
  select 1 from public.finance_month_closings c
  where c.organization_id = p_organization_id and c.month = p_month and c.reopened_at is null
 ) then raise exception 'Finance month already closed' using errcode = 'P0001'; end if;
 insert into public.finance_month_closings (organization_id, month, note, closed_by)
 values (p_organization_id, p_month, btrim(p_note), auth.uid())
 returning id into closing_id;
 return private.finance_month_closing_payload(closing_id);
end;
$$;
revoke all on function public.close_finance_month(uuid, date, text) from public, anon, authenticated;
grant execute on function public.close_finance_month(uuid, date, text) to authenticated;

create or replace function public.reopen_finance_month(p_organization_id uuid, p_month date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
 closing public.finance_month_closings%rowtype;
begin
 if auth.uid() is null or p_organization_id is null
  or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[])
 then raise exception 'Finance month reopen permission required' using errcode = '42501'; end if;
 if p_month is null or p_month <> date_trunc('month', p_month::timestamp)::date
  or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
 then raise exception 'Invalid finance month reopen' using errcode = '22023'; end if;
 perform private.finance_month_lock(p_organization_id, p_month);
 select * into closing from public.finance_month_closings c
 where c.organization_id = p_organization_id and c.month = p_month and c.reopened_at is null
 for update;
 if not found then raise exception 'Finance month is not closed' using errcode = 'P0002'; end if;
 update public.finance_month_closings
 set reopened_by = auth.uid(), reopened_at = now(), reopen_reason = btrim(p_reason)
 where id = closing.id;
 return private.finance_month_closing_payload(closing.id);
end;
$$;
revoke all on function public.reopen_finance_month(uuid, date, text) from public, anon, authenticated;
grant execute on function public.reopen_finance_month(uuid, date, text) to authenticated;

/* ------------------------------------------------------------------ */
/* SALE-10: 수납·환불·반품 내역 검색                                    */
/* ------------------------------------------------------------------ */
-- 반환: { rows: [...], next_cursor: {occurred_at, id} | null, totals: {...} }
-- kind: payment(수납, 회원권 사용 포함) / refund(환불) / return(상품 반품 환불). method: cash/card/transfer/wallet.
-- 기간은 한국 표준시(KST) 날짜 기준이다. 정렬은 발생 시각(newest|oldest)이고 cursor는 직전 페이지의 마지막 행 값이다.
-- 합계는 페이지와 무관하게 조건에 맞는 전체 행으로 계산한다(순매출 = 수납 - 환불·반품).
create or replace function public.list_sale_payments(
 p_organization_id uuid,
 p_from_date date default null,
 p_to_date date default null,
 p_customer_id uuid default null,
 p_method text default null,
 p_kind text default null,
 p_min_amount text default null,
 p_max_amount text default null,
 p_sort text default 'newest',
 p_limit integer default 50,
 p_cursor_at timestamptz default null,
 p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
 min_value numeric;
 max_value numeric;
 oldest boolean;
 result jsonb;
begin
 if auth.uid() is null or p_organization_id is null
  or not private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[])
 then raise exception 'Sale payment read permission required' using errcode = '42501'; end if;
 if (p_method is not null and p_method not in ('cash', 'card', 'transfer', 'wallet'))
  or (p_kind is not null and p_kind not in ('payment', 'refund', 'return'))
  or (p_sort is not null and p_sort not in ('newest', 'oldest'))
  or (p_from_date is not null and p_to_date is not null and p_from_date > p_to_date)
  or (p_min_amount is not null and p_min_amount !~ '^(0|[1-9][0-9]{0,11})$')
  or (p_max_amount is not null and p_max_amount !~ '^(0|[1-9][0-9]{0,11})$')
  or ((p_cursor_at is null) <> (p_cursor_id is null))
  or p_limit is null or p_limit < 1 or p_limit > 200
 then raise exception 'Invalid sale payment search' using errcode = '22023'; end if;
 min_value := p_min_amount::numeric;
 max_value := p_max_amount::numeric;
 if min_value is not null and max_value is not null and min_value > max_value
 then raise exception 'Invalid sale payment search' using errcode = '22023'; end if;
 oldest := coalesce(p_sort, 'newest') = 'oldest';

 with events as (
  select r.id, 'payment'::text kind, r.method, r.amount::numeric amount, r.received_at occurred_at, r.reference, ''::text reason, r.cart_id, r.visit_id
  from public.visit_payment_receipts r where r.organization_id = p_organization_id
  union all
  select u.id, 'payment'::text, 'wallet'::text, u.applied_amount::numeric, u.created_at,
   coalesce(w.name_snapshot, ''), ''::text, u.cart_id, u.visit_id
  from public.wallet_usage_ledger u
  left join public.customer_wallets w on w.id = u.wallet_id
  where u.organization_id = p_organization_id
  union all
  select f.id, case when pr.id is null then 'refund' else 'return' end, coalesce(rc.method, 'wallet'), f.amount::numeric, f.created_at,
   coalesce(rc.reference, ''), f.reason, f.cart_id, f.visit_id
  from public.visit_payment_refunds f
  left join public.visit_payment_receipts rc on rc.id = f.receipt_id
  left join public.visit_product_returns pr on pr.organization_id = f.organization_id and pr.operation_id = f.operation_id
  where f.organization_id = p_organization_id
 ), filtered as (
  select x.*, c.customer_id, cu.name customer_name
  from events x
  join public.sale_carts c on c.id = x.cart_id and c.organization_id = p_organization_id
  join public.customers cu on cu.id = c.customer_id
  where (p_from_date is null or (x.occurred_at at time zone 'Asia/Seoul')::date >= p_from_date)
   and (p_to_date is null or (x.occurred_at at time zone 'Asia/Seoul')::date <= p_to_date)
   and (p_customer_id is null or c.customer_id = p_customer_id)
   and (p_method is null or x.method = p_method)
   and (p_kind is null or x.kind = p_kind)
   and (min_value is null or x.amount >= min_value)
   and (max_value is null or x.amount <= max_value)
 ), totals as (
  select jsonb_build_object(
   'payment_total', coalesce(sum(amount) filter (where kind = 'payment'), 0),
   'refund_total', coalesce(sum(amount) filter (where kind in ('refund', 'return')), 0),
   'net_total', coalesce(sum(amount) filter (where kind = 'payment'), 0) - coalesce(sum(amount) filter (where kind in ('refund', 'return')), 0),
   'payment_count', count(*) filter (where kind = 'payment'),
   'refund_count', count(*) filter (where kind in ('refund', 'return')),
   'row_count', count(*)
  ) as summary from filtered
 ), page as (
  select s.*, row_number() over (
    order by case when oldest then s.occurred_at end asc, case when not oldest then s.occurred_at end desc,
     case when oldest then s.id end asc, case when not oldest then s.id end desc) as seq
  from (
   select * from filtered f
   where p_cursor_at is null
    or (case when oldest then (f.occurred_at, f.id) > (p_cursor_at, p_cursor_id) else (f.occurred_at, f.id) < (p_cursor_at, p_cursor_id) end)
   order by case when oldest then f.occurred_at end asc, case when not oldest then f.occurred_at end desc,
    case when oldest then f.id end asc, case when not oldest then f.id end desc
   limit p_limit + 1
  ) s
 )
 select jsonb_build_object(
  'rows', coalesce((
   select jsonb_agg(jsonb_build_object(
    'id', g.id, 'kind', g.kind, 'method', g.method, 'amount', g.amount, 'occurred_at', g.occurred_at,
    'reference', g.reference, 'reason', g.reason, 'cart_id', g.cart_id, 'visit_id', g.visit_id,
    'customer_id', g.customer_id, 'customer_name', g.customer_name
   ) order by g.seq)
   from page g where g.seq <= p_limit
  ), '[]'::jsonb),
  'next_cursor', (
   select jsonb_build_object('occurred_at', g.occurred_at, 'id', g.id)
   from page g where g.seq = p_limit and exists (select 1 from page h where h.seq = p_limit + 1)
  ),
  'totals', (select summary from totals)
 ) into result;
 return result;
end;
$$;
revoke all on function public.list_sale_payments(uuid, date, date, uuid, text, text, text, text, text, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_sale_payments(uuid, date, date, uuid, text, text, text, text, text, integer, timestamptz, uuid) to authenticated;

/* ------------------------------------------------------------------ */
/* HOME-02: 조직 전체 미수금 요약                                       */
/* ------------------------------------------------------------------ */
-- 수납 중(collecting)인 장바구니의 미수 = 총액 - (수납 + 회원권 사용 - 환불), 0 미만은 0. 033의 일 정산 미수와 같은 계산이다.
-- items는 방문이 오래된 순으로 최대 p_limit(1~50)건이다.
create or replace function public.get_receivables_summary(p_organization_id uuid, p_limit integer default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
 result jsonb;
begin
 if auth.uid() is null or p_organization_id is null
  or not private.has_organization_role(p_organization_id, array['owner', 'admin', 'member']::text[])
 then raise exception 'Receivables read permission required' using errcode = '42501'; end if;
 if p_limit is null or p_limit < 1 or p_limit > 50
 then raise exception 'Invalid receivables request' using errcode = '22023'; end if;
 with cart_rows as (
  select c.id cart_id, c.visit_id, c.customer_id, cu.name customer_name, cv.opened_at, c.total_amount,
   coalesce(a.received, 0) + coalesce(w.received, 0) received_amount,
   coalesce(f.refunded, 0) refunded_amount,
   greatest(c.total_amount - (coalesce(a.received, 0) + coalesce(w.received, 0)) + coalesce(f.refunded, 0), 0) due_amount
  from public.sale_carts c
  join public.customer_visits cv on cv.id = c.visit_id
  join public.customers cu on cu.id = c.customer_id
  left join lateral (select sum(r.amount) received from public.visit_payment_receipts r where r.cart_id = c.id) a on true
  left join lateral (select sum(u.applied_amount) received from public.wallet_usage_ledger u where u.cart_id = c.id) w on true
  left join lateral (select sum(x.amount) refunded from public.visit_payment_refunds x where x.cart_id = c.id) f on true
  where c.organization_id = p_organization_id and c.status = 'collecting'
 ), due as (
  select * from cart_rows where due_amount > 0
 )
 select jsonb_build_object(
  'receivable_count', (select count(*) from due),
  'total_due', coalesce((select sum(due_amount) from due), 0),
  'items', coalesce((
   select jsonb_agg(jsonb_build_object(
    'cart_id', d.cart_id, 'visit_id', d.visit_id, 'customer_id', d.customer_id, 'customer_name', d.customer_name,
    'opened_at', d.opened_at, 'total_amount', d.total_amount, 'received_amount', d.received_amount,
    'refunded_amount', d.refunded_amount, 'due_amount', d.due_amount
   ) order by d.opened_at, d.cart_id)
   from (select * from due order by opened_at, cart_id limit p_limit) d
  ), '[]'::jsonb)
 ) into result;
 return result;
end;
$$;
revoke all on function public.get_receivables_summary(uuid, integer) from public, anon, authenticated;
grant execute on function public.get_receivables_summary(uuid, integer) to authenticated;

commit;
