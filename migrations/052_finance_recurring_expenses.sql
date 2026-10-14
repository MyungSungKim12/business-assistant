-- 052: FIN-11 반복 지출.
-- 월세·통신비처럼 매달 나가는 지출을 템플릿으로 저장해 두고, 월마다 버튼 한 번으로 그 달의 지출을 등록한다.
-- 자동으로 실행하는 작업은 없다(관리자가 누를 때만 등록). 같은 달에 같은 반복 지출은 한 번만 등록되어 여러 번 눌러도 중복되지 않는다.
-- 등록된 지출은 일반 수입·지출 거래와 같아서 이후 수정·보관은 기존 방식 그대로이며, 마감된 달에는 등록되지 않는다(042).
-- 042 이후에 적용한다. 새 테이블·함수·트리거·정책 추가뿐이라 기존 행을 바꾸지 않고 여러 번 실행해도 안전하다. 적용 후 API 서버를 재시작한다.
begin;

create table if not exists public.finance_recurring_expenses (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check (char_length(btrim(name)) between 1 and 120),
 amount numeric(14, 2) not null check (amount > 0),
 category text not null check (char_length(btrim(category)) between 1 and 200),
 counterparty text not null default '' check (char_length(counterparty) <= 5000),
 memo text not null default '' check (char_length(memo) <= 5000),
 -- 매달 며칠에 나가는지. 31일 같은 값은 그 달의 마지막 날로 맞춘다.
 day_of_month integer not null check (day_of_month between 1 and 31),
 is_active boolean not null default true,
 created_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1 check (version > 0)
);
create unique index if not exists finance_recurring_expenses_name
 on public.finance_recurring_expenses (organization_id, lower(btrim(name)));

-- 어느 달에 어느 거래로 등록했는지 기록한다. (반복 지출, 달) 하나만 있어 중복 등록을 막는다.
create table if not exists public.finance_recurring_runs (
 recurring_id uuid not null references public.finance_recurring_expenses(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 month date not null check (month = date_trunc('month', month)::date),
 transaction_id uuid references public.finance_transactions(id) on delete set null,
 created_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 primary key (recurring_id, month)
);
create index if not exists finance_recurring_runs_org_month on public.finance_recurring_runs (organization_id, month);

alter table public.finance_recurring_expenses enable row level security;
alter table public.finance_recurring_runs enable row level security;
drop policy if exists finance_recurring_expenses_select on public.finance_recurring_expenses;
create policy finance_recurring_expenses_select on public.finance_recurring_expenses
 for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
drop policy if exists finance_recurring_expenses_insert on public.finance_recurring_expenses;
create policy finance_recurring_expenses_insert on public.finance_recurring_expenses
 for insert to authenticated with check (
  created_by = (select auth.uid()) and (select private.has_organization_role(organization_id, array['owner','admin']::text[]))
 );
drop policy if exists finance_recurring_expenses_update on public.finance_recurring_expenses;
create policy finance_recurring_expenses_update on public.finance_recurring_expenses
 for update to authenticated
 using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])))
 with check ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists finance_recurring_expenses_delete on public.finance_recurring_expenses;
create policy finance_recurring_expenses_delete on public.finance_recurring_expenses
 for delete to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin']::text[])));
drop policy if exists finance_recurring_runs_select on public.finance_recurring_runs;
create policy finance_recurring_runs_select on public.finance_recurring_runs
 for select to authenticated using ((select private.has_organization_role(organization_id, array['owner','admin','member']::text[])));
revoke all on public.finance_recurring_expenses, public.finance_recurring_runs from public, anon, authenticated;
grant select, insert, update, delete on public.finance_recurring_expenses to authenticated;
grant select on public.finance_recurring_runs to authenticated;

create or replace function private.touch_finance_recurring_expense()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'Recurring expense organization and creator are immutable' using errcode = '42501';
 end if;
 new.version := old.version + 1;
 new.updated_at := now();
 new.created_at := old.created_at;
 return new;
end $$;
revoke all on function private.touch_finance_recurring_expense() from public, anon, authenticated;
drop trigger if exists finance_recurring_expenses_touch on public.finance_recurring_expenses;
create trigger finance_recurring_expenses_touch before update on public.finance_recurring_expenses
 for each row execute function private.touch_finance_recurring_expense();

-- 한 달치 반복 지출을 등록한다(owner/admin). 이미 그 달에 등록한 항목은 건너뛰므로 여러 번 불러도 안전하다.
-- 마감된 달(042)이면 아무것도 등록하지 않고 'Finance month is closed'(P0001)로 거절한다.
-- 다음 달보다 먼 미래는 등록할 수 없다.
create or replace function public.generate_finance_recurring_expenses(p_organization_id uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 month_start date;
 last_day integer;
 item public.finance_recurring_expenses%rowtype;
 new_id uuid;
 created_ids uuid[] := '{}';
 skipped integer := 0;
 limit_month date := (date_trunc('month', timezone('Asia/Seoul', now())) + interval '1 month')::date;
begin
 if auth.uid() is null or p_organization_id is null
    or not private.has_organization_role(p_organization_id, array['owner', 'admin']::text[]) then
  raise exception 'Organization manager required' using errcode = '42501';
 end if;
 if p_month is null then raise exception 'Month required' using errcode = '22023'; end if;
 month_start := date_trunc('month', p_month::timestamp)::date;
 if month_start > limit_month then raise exception 'Month is too far in the future' using errcode = '22023'; end if;
 last_day := extract(day from (month_start + interval '1 month - 1 day'))::integer;
 perform private.finance_month_lock(p_organization_id, month_start);
 if exists (
  select 1 from public.finance_month_closings c
  where c.organization_id = p_organization_id and c.month = month_start and c.reopened_at is null
 ) then
  raise exception 'Finance month is closed' using errcode = 'P0001';
 end if;
 for item in
  select * from public.finance_recurring_expenses e
  where e.organization_id = p_organization_id and e.is_active order by e.name, e.id
 loop
  if exists (select 1 from public.finance_recurring_runs r where r.recurring_id = item.id and r.month = month_start) then
   skipped := skipped + 1;
  else
   insert into public.finance_transactions (organization_id, transaction_type, amount, transaction_date, category, counterparty, memo, created_by)
   values (
    p_organization_id, 'expense', item.amount, month_start + (least(item.day_of_month, last_day) - 1), item.category, item.counterparty,
    '반복 지출: ' || item.name || case when item.memo <> '' then ' — ' || item.memo else '' end, auth.uid()
   ) returning id into new_id;
   insert into public.finance_recurring_runs (recurring_id, organization_id, month, transaction_id, created_by)
   values (item.id, p_organization_id, month_start, new_id, auth.uid());
   created_ids := created_ids || new_id;
  end if;
 end loop;
 return jsonb_build_object('month', month_start, 'created', coalesce(array_length(created_ids, 1), 0), 'skipped', skipped, 'transaction_ids', to_jsonb(created_ids));
end $$;
revoke all on function public.generate_finance_recurring_expenses(uuid, date) from public, anon;
grant execute on function public.generate_finance_recurring_expenses(uuid, date) to authenticated;

commit;
