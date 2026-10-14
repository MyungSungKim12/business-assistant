// SQL 마이그레이션 계약 테스트 (apps/server/tests/test_migration_contract.py 이식).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../migrations');

// Python read_text()의 universal newline(CRLF→LF) 동작을 맞춘다.
function readRaw(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf-8').replace(/\r\n?/g, '\n');
}
function readLower(name: string): string {
  return readRaw(name).toLowerCase();
}

const SUBSCRIPTION_POLICY_STATEMENT_PATTERN =
  /\bcreate\s+policy\b(?:(?!;)[\s\S])*?\bon\s+public\.subscriptions\b(?:(?!;)[\s\S])*?;/gi;
// Python fullmatch 대응: ^...$ (m 플래그 없음)
const INTENDED_SUBSCRIPTION_POLICY_PATTERN = new RegExp(
  '^create policy (?:"subscriptions_select_member"|subscriptions_select_member) ' +
    'on public\\.subscriptions (?:as permissive )?for select to authenticated ' +
    'using \\(\\(select private\\.has_organization_role\\(organization_id, ' +
    "array\\['owner', 'admin', 'member'\\]::text\\[\\]\\)\\)\\);$",
  'i',
);

function subscriptionPolicyStatements(schema: string): string[] {
  return [...schema.matchAll(SUBSCRIPTION_POLICY_STATEMENT_PATTERN)].map((m) =>
    m[0].replace(/\s+/g, ' ').trim(),
  );
}

const has = (text: string, needle: string) => expect(text.includes(needle), needle).toBe(true);
const hasNot = (text: string, needle: string) => expect(text.includes(needle), needle).toBe(false);

describe('migrations contract', () => {
  it('test_visit_sale_cart_schema_is_scoped_versioned_and_auditable', () => {
    const m = readLower('024_visit_sale_carts.sql');
    for (const table of ['customer_visits', 'sale_carts', 'sale_cart_lines', 'sale_cart_operations']) {
      has(m, `create table public.${table}`);
      has(m, `alter table public.${table} enable row level security`);
    }
    has(m, 'version bigint not null default 1');
    has(m, "status text not null default 'active'");
    has(m, 'source_type text not null');
    has(m, 'source_snapshot jsonb not null');
    has(m, 'sale_cart_lines_active_source');
  });

  it('test_visit_sale_cart_mutations_are_rpc_only_and_role_checked', () => {
    const m = readLower('024_visit_sale_carts.sql');
    for (const fn of [
      'create_customer_visit',
      'add_treatment_draft_to_cart',
      'mutate_sale_cart_line',
      'review_sale_cart',
      'cancel_customer_visit',
    ]) {
      has(m, `create function public.${fn}`);
      has(m, `revoke all on function public.${fn}`);
    }
    has(m, "array['owner', 'admin']::text[]");
    has(m, 'grant select on public.customer_visits');
    has(m, 'grant select on public.sale_carts');
    has(m, 'grant select on public.sale_cart_lines');
    has(m, 'grant select on public.sale_cart_operations');
    hasNot(m, 'grant insert');
  });

  it('test_files_migration_defines_org_scoped_metadata_and_storage_rls', () => {
    const m = readLower('009_file_assets.sql');
    has(m, 'create table public.file_assets');
    has(m, 'alter table public.file_assets enable row level security');
    has(m, 'idx_file_assets_org_archived_created');
    has(m, 'storage.buckets');
    has(m, 'business_files_select_member');
    has(m, 'business_files_insert_member');
  });

  it('test_authenticated_grants_migration_exposes_rls_protected_tables', () => {
    const m = readLower('010_authenticated_grants.sql');
    has(m, 'grant usage on schema public to authenticated');
    has(m, 'public.memberships');
    has(m, 'public.file_assets');
    has(m, 'to authenticated');
  });

  it('test_organization_insert_policy_requires_an_authenticated_creator', () => {
    const m = readLower('011_organization_insert_policy.sql');
    has(m, 'drop policy if exists "organizations_insert_authenticated"');
    has(m, 'create policy "organizations_insert_authenticated"');
    has(m, 'for insert');
    has(m, 'to authenticated');
    has(m, '(select auth.uid()) is not null');
  });

  it('test_organization_creation_rpc_is_restricted_to_authenticated_users', () => {
    const m = readLower('012_create_organization_rpc.sql');
    has(m, 'create or replace function public.create_organization');
    has(m, 'security definer');
    has(m, 'if (select auth.uid()) is null');
    has(m, 'revoke all on function public.create_organization');
    has(m, 'grant execute on function public.create_organization');
  });

  it('test_schema_defines_auth_and_entitlement_tables_with_foreign_keys', () => {
    const schema = readLower('001_auth_entitlements.sql');
    for (const t of ['profiles', 'organizations', 'memberships', 'features', 'plans', 'plan_features', 'subscriptions']) {
      has(schema, `create table public.${t}`);
    }
    for (const fk of [
      'references auth.users(id)',
      'references public.organizations(id)',
      'references public.plans(id)',
      'references public.features(code)',
    ]) {
      has(schema, fk);
    }
  });

  it('test_schema_enforces_membership_uniqueness_and_indexes_foreign_keys', () => {
    const schema = readLower('001_auth_entitlements.sql');
    has(schema, 'unique (organization_id, user_id)');
    for (const idx of [
      'idx_memberships_organization_id',
      'idx_memberships_user_id',
      'idx_plan_features_plan_id',
      'idx_plan_features_feature_code',
      'idx_subscriptions_organization_id',
      'idx_subscriptions_plan_id',
      'idx_subscriptions_active_lookup',
    ]) {
      has(schema, `create index ${idx}`);
    }
  });

  it('test_schema_enables_rls_and_uses_membership_based_policies', () => {
    const schema = readLower('001_auth_entitlements.sql');
    for (const t of ['profiles', 'organizations', 'memberships', 'features', 'plans', 'plan_features', 'subscriptions']) {
      has(schema, `alter table public.${t} enable row level security`);
    }
    has(schema, 'to authenticated');
    has(schema, '(select auth.uid())');
    has(schema, "'owner', 'admin'");
  });

  it('test_schema_bootstraps_the_creator_as_the_first_organization_owner', () => {
    const schema = readLower('001_auth_entitlements.sql');
    has(schema, 'create function private.bootstrap_organization_owner');
    has(schema, 'after insert on public.organizations');
    has(schema, 'execute function private.bootstrap_organization_owner()');
    has(schema, "values (new.id, (select auth.uid()), 'owner')");
  });

  it('test_schema_reserves_subscription_mutation_for_the_trusted_server_path', () => {
    const schema = readLower('001_auth_entitlements.sql');
    for (const action of ['insert', 'update', 'delete']) {
      hasNot(schema, `on public.subscriptions\nfor ${action}\nto authenticated`);
    }
    has(schema, 'subscription mutations are reserved for the trusted server/platform path');
  });

  it('test_schema_rejects_all_subscription_policy_mutation_variants', () => {
    const schema = readLower('001_auth_entitlements.sql');
    const statements = subscriptionPolicyStatements(schema);
    expect(statements).toHaveLength(1);
    expect(INTENDED_SUBSCRIPTION_POLICY_PATTERN.test(statements[0]!)).toBe(true);

    for (const forbidden of [
      'create policy "subscriptions_all" on public.subscriptions for all to authenticated using (true);',
      'create policy "subscriptions_insert" on public.subscriptions for insert to authenticated with check (true);',
      'create policy "subscriptions_public" on public.subscriptions for select to public using (true);',
      'create policy subscriptions_all on public.subscriptions as permissive for all to authenticated using (true);',
      'create policy subscriptions_all on public.subscriptions;',
      'create policy subscriptions_all on public.subscriptions for all to public;',
    ]) {
      expect(subscriptionPolicyStatements(`${schema}\n${forbidden}`), forbidden).toHaveLength(2);
    }
  });

  it('test_seed_defines_required_plans_and_feature_codes', () => {
    const seed = readLower('002_seed_entitlements.sql');
    for (const plan of ['basic', 'standard', 'pro']) has(seed, `'${plan}'`);
    for (const code of [
      'dashboard.basic',
      'crm.basic',
      'document.template',
      'data.basic',
      'reports.basic',
      'automation.custom',
      'ai.summary',
    ]) {
      has(seed, `'${code}'`);
    }
  });

  it('test_hardening_enforces_one_active_subscription_per_organization', () => {
    const h = readLower('003_subscription_and_organization_hardening.sql');
    has(h, 'create unique index idx_subscriptions_one_active_per_organization');
    has(h, 'on public.subscriptions (organization_id)');
    has(h, "where status in ('trialing', 'active')");
  });

  it('test_hardening_exposes_only_authenticated_existence_rpc_with_auth_guard', () => {
    const h = readLower('003_subscription_and_organization_hardening.sql');
    has(h, 'create function public.organization_exists(target_organization_id uuid)');
    has(h, 'security definer');
    has(h, "set search_path = ''");
    has(h, 'if (select auth.uid()) is null then');
    has(h, 'revoke all on function public.organization_exists(uuid) from public');
    has(h, 'grant execute on function public.organization_exists(uuid) to authenticated');
  });

  it('test_admin_subscription_rpc_is_atomic_and_service_role_only', () => {
    const m = readLower('004_admin_subscription_rpc.sql');
    has(m, 'create function public.replace_organization_subscription');
    has(m, 'security definer');
    has(m, "set search_path = ''");
    has(m, 'delete from public.subscriptions');
    has(m, 'insert into public.subscriptions');
    has(m, 'revoke all on function public.replace_organization_subscription');
    has(m, 'from public');
    has(m, 'from anon');
    has(m, 'from authenticated');
    has(m, 'grant execute on function public.replace_organization_subscription');
    has(m, 'to service_role');
  });

  it('test_crm_customers_schema_is_tenant_scoped_and_indexed', () => {
    const m = readLower('005_crm_customers.sql');
    has(m, 'create table public.customers');
    has(m, 'organization_id uuid not null references public.organizations(id) on delete cascade');
    has(m, 'email text');
    has(m, 'phone text');
    has(m, "notes text not null default ''");
    has(m, 'create index idx_customers_organization_id on public.customers (organization_id)');
  });

  it('test_crm_customers_uses_member_read_and_manager_mutation_rls', () => {
    const m = readLower('005_crm_customers.sql');
    has(m, 'alter table public.customers enable row level security');
    has(m, 'create policy "customers_select_member"');
    has(m, 'for select\nto authenticated');
    has(m, "array['owner', 'admin', 'member']::text[]");
    for (const action of ['insert', 'update', 'delete']) {
      has(m, `create policy "customers_${action}_manager"`);
    }
  });

  it('test_crm_customer_activities_schema_is_tenant_scoped_and_indexed', () => {
    // 원본은 소문자화하지 않고 읽는다.
    const m = readRaw('013_customer_activities.sql');
    has(m, 'create table public.customer_activities');
    has(m, 'customer_id uuid not null references public.customers(id) on delete cascade');
    has(m, 'organization_id uuid not null references public.organizations(id) on delete cascade');
    has(m, 'create index idx_customer_activities_customer_occurred');
    has(m, 'alter table public.customer_activities enable row level security');
    has(m, 'create policy "customer_activities_select_member"');
    has(m, 'create policy "customer_activities_insert_member"');
    has(m, 'create policy "customer_activities_delete_manager"');
    has(m, "array['owner', 'admin']::text[]");
  });

  it('test_customer_records_schema_contains_profile_treatments_and_photos_with_rls', () => {
    // 원본은 소문자화하지 않고 읽는다.
    const m = readRaw('014_customer_records.sql');
    for (const column of [
      'birth_date date',
      'skin_type text',
      'concerns text[]',
      'allergies text',
      'last_visit_date date',
      'next_visit_date date',
      'tags text[]',
    ]) {
      has(m, column);
    }
    for (const t of ['treatment_records', 'treatment_photos']) {
      has(m, `create table public.${t}`);
      has(m, `alter table public.${t} enable row level security`);
    }
    has(m, 'idx_treatment_records_customer_date');
    has(m, 'idx_treatment_photos_treatment_sort');
    has(m, 'treatment_records_select_member');
    has(m, 'treatment_photos_select_member');
  });

  it('test_customer_demo_seed_contains_safe_profile_treatment_and_photo_examples', () => {
    const seed = readRaw('015_seed_customer_demo.sql').toLowerCase();
    has(seed, 'insert into public.customers');
    has(seed, 'insert into public.treatment_records');
    has(seed, 'insert into public.treatment_photos');
    has(seed, "where o.slug = 'test'");
  });

  it('test_customer_photos_migration_is_tenant_scoped_and_image_restricted', () => {
    const m = readLower('022_customer_photos.sql');
    has(m, 'create table public.customer_photos');
    has(m, 'customer_photos_customer_scope');
    has(m, "content_type in ('image/jpeg', 'image/png', 'image/webp')");
    has(m, 'size_bytes > 0 and size_bytes <= 10485760');
    has(m, 'create policy "customer_photos_select_member"');
    has(m, 'create policy "customer_photos_insert_manager"');
    has(m, 'business_files_customer_photo_insert_manager');
    has(m, 'drop policy if exists "business_files_insert_member"');
    has(m, "split_part(name, '/', 2) ~*");
  });

  it('test_customer_photo_storage_migration_creates_private_bucket_idempotently', () => {
    const m = readLower('023_customer_photo_storage_bucket.sql');
    has(m, 'insert into storage.buckets');
    has(m, "'business-files', 'business-files', false");
    has(m, 'on conflict (id) do update');
  });

  it('test_tasks_schema_and_rls_are_organization_scoped', () => {
    const m = readLower('006_tasks.sql');
    has(m, 'create table public.tasks');
    has(m, 'created_by uuid not null references auth.users(id)');
    has(m, "status text not null default 'open'");
    has(m, "priority text not null default 'normal'");
    has(m, 'create index idx_tasks_organization_status');
    has(m, 'alter table public.tasks enable row level security');
    has(m, 'create policy "tasks_select_member"');
    has(m, 'create policy "tasks_update_creator_or_manager"');
    has(m, 'create function private.prevent_task_tenant_change');
    has(m, 'new.organization_id is distinct from old.organization_id');
    has(m, 'new.created_by is distinct from old.created_by');
    has(m, 'create trigger tasks_prevent_tenant_change before update on public.tasks');
    has(m, 'execute function private.prevent_task_tenant_change()');
  });

  it('test_documents_schema_is_tenant_scoped_and_indexed', () => {
    const m = readLower('007_documents.sql');
    for (const t of ['document_templates', 'documents']) {
      has(m, `create table public.${t}`);
      has(m, `alter table public.${t} enable row level security`);
      has(m, `create index idx_${t}_organization_updated`);
    }
    has(m, 'template_id uuid references public.document_templates(id)');
    has(m, "status text not null default 'draft'");
    has(m, "check (status in ('draft', 'final', 'archived'))");
    has(m, 'created_by uuid not null references auth.users(id)');
  });

  it('test_documents_rls_allows_member_reads_and_manager_mutations', () => {
    const m = readLower('007_documents.sql');
    for (const t of ['document_templates', 'documents']) {
      has(m, `create policy "${t}_select_member"`);
      has(m, `create policy "${t}_insert_manager"`);
      has(m, `create policy "${t}_update_manager"`);
      has(m, "array['owner', 'admin', 'member']::text[]");
      has(m, "array['owner', 'admin']::text[]");
    }
    has(m, 'document_template_same_organization');
  });

  it('test_documents_reject_tenant_changes_with_before_update_triggers', () => {
    const m = readLower('007_documents.sql');
    for (const t of ['document_templates', 'documents']) {
      has(m, `prevent_${t}_tenant_change`);
      has(m, `create trigger ${t}_prevent_tenant_change before update on public.${t}`);
      has(m, 'new.organization_id is distinct from old.organization_id');
      has(m, 'new.created_by is distinct from old.created_by');
    }
  });

  it('test_finance_transactions_schema_is_tenant_scoped_and_constrained', () => {
    const m = readLower('008_finance_transactions.sql');
    has(m, 'create table public.finance_transactions');
    has(m, 'organization_id uuid not null references public.organizations(id)');
    has(m, 'transaction_type text not null');
    has(m, "check (transaction_type in ('income', 'expense'))");
    has(m, 'amount numeric(14, 2) not null');
    has(m, 'check (amount > 0)');
    has(m, 'transaction_date date not null');
    has(m, 'category text not null');
    has(m, 'create index idx_finance_transactions_organization_date');
    has(m, 'create index idx_finance_transactions_organization_type_date');
    has(m, 'alter table public.finance_transactions enable row level security');
  });

  it('test_finance_transactions_rls_allows_member_reads_and_manager_mutations', () => {
    const m = readLower('008_finance_transactions.sql');
    for (const p of [
      'finance_transactions_select_member',
      'finance_transactions_insert_manager',
      'finance_transactions_update_manager',
    ]) {
      has(m, `create policy "${p}"`);
    }
    has(m, "array['owner', 'admin', 'member']::text[]");
    has(m, "array['owner', 'admin']::text[]");
    has(m, 'create function private.prevent_finance_transactions_tenant_change');
    has(m, 'create trigger finance_transactions_prevent_tenant_change before update');
    has(m, 'new.organization_id is distinct from old.organization_id');
    has(m, 'new.created_by is distinct from old.created_by');
  });
  it('TRT-11 treatment consumables are tenant-scoped and atomically deducted', () => {
    const m = readLower('046_treatment_consumables.sql');
    const catalog = readLower('027_catalog_sales.sql');
    for (const token of [
      'create table if not exists public.appointment_service_consumables',
      'foreign key (organization_id, service_id)',
      'foreign key (organization_id, product_id)',
      "kind='product' and is_active",
      'create or replace function public.set_treatment_service',
      'create trigger treatment_consumables_on_complete',
      "movement_kind='treatment_use'",
      "movement_kind='customer_return'",
      "movement_kind in ('adjustment','supplier_return','disposal','stocktake')",
      'for update',
      'insufficient product stock',
    ]) has(m, token);
    has(m, "array['owner','admin']::text[]");
    has(m, 'revoke all on function public.set_treatment_service(uuid,uuid,uuid,uuid,integer,uuid)');
    has(m, "'consult'");
    has(m, "'service_link'");
    has(catalog, 'create trigger immutable before update or delete on public.catalog_stock_ledger');
  });
});
