begin;

create table public.finance_transactions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 transaction_type text not null check (transaction_type in ('income', 'expense')),
 amount numeric(14, 2) not null check (amount > 0),
 transaction_date date not null,
 category text not null check (length(btrim(category)) > 0),
 counterparty text not null default '',
 memo text not null default '',
 is_archived boolean not null default false,
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default timezone('utc', now()),
 updated_at timestamptz not null default timezone('utc', now())
);

create index idx_finance_transactions_organization_date
 on public.finance_transactions (organization_id, transaction_date desc);
create index idx_finance_transactions_organization_type_date
 on public.finance_transactions (organization_id, transaction_type, transaction_date desc);

alter table public.finance_transactions enable row level security;

create function private.prevent_finance_transactions_tenant_change()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.organization_id is distinct from old.organization_id or new.created_by is distinct from old.created_by then
  raise exception 'finance transaction organization and creator are immutable';
 end if;
 new.updated_at = timezone('utc', now());
 return new;
end;
$$;
revoke all on function private.prevent_finance_transactions_tenant_change() from public;
create trigger finance_transactions_prevent_tenant_change before update on public.finance_transactions
 for each row execute function private.prevent_finance_transactions_tenant_change();

create policy "finance_transactions_select_member" on public.finance_transactions
 for select to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin', 'member']::text[])));
create policy "finance_transactions_insert_manager" on public.finance_transactions
 for insert to authenticated
 with check (
  created_by = (select auth.uid())
  and (select private.has_organization_role(organization_id, array['owner', 'admin']::text[]))
 );
create policy "finance_transactions_update_manager" on public.finance_transactions
 for update to authenticated
 using ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])))
 with check ((select private.has_organization_role(organization_id, array['owner', 'admin']::text[])));

commit;
