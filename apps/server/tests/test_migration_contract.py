import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = PROJECT_ROOT / "migrations" / "001_auth_entitlements.sql"
SEED_PATH = PROJECT_ROOT / "migrations" / "002_seed_entitlements.sql"
HARDENING_PATH = PROJECT_ROOT / "migrations" / "003_subscription_and_organization_hardening.sql"
ADMIN_PATH = PROJECT_ROOT / "migrations" / "004_admin_subscription_rpc.sql"
CRM_PATH = PROJECT_ROOT / "migrations" / "005_crm_customers.sql"
TASKS_PATH = PROJECT_ROOT / "migrations" / "006_tasks.sql"
DOCUMENTS_PATH = PROJECT_ROOT / "migrations" / "007_documents.sql"
_SUBSCRIPTION_POLICY_STATEMENT_PATTERN = re.compile(
    r"\bcreate\s+policy\b(?:(?!;)[\s\S])*?\bon\s+public\.subscriptions\b"
    r"(?:(?!;)[\s\S])*?;",
    re.IGNORECASE,
)
_INTENDED_SUBSCRIPTION_POLICY_PATTERN = re.compile(
    r'create policy (?:"subscriptions_select_member"|subscriptions_select_member) '
    r"on public\.subscriptions (?:as permissive )?for select to authenticated "
    r"using \(\(select private\.has_organization_role\(organization_id, "
    r"array\['owner', 'admin', 'member'\]::text\[\]\)\)\);",
    re.IGNORECASE,
)


def _read_schema() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8").lower()


def _read_seed() -> str:
    return SEED_PATH.read_text(encoding="utf-8").lower()


def _read_hardening() -> str:
    return HARDENING_PATH.read_text(encoding="utf-8").lower()


def _read_admin_migration() -> str:
    return ADMIN_PATH.read_text(encoding="utf-8").lower()


def _read_crm_migration() -> str:
    return CRM_PATH.read_text(encoding="utf-8").lower()


def _read_tasks_migration() -> str:
    return TASKS_PATH.read_text(encoding="utf-8").lower()


def _read_documents_migration() -> str:
    return DOCUMENTS_PATH.read_text(encoding="utf-8").lower()


def _subscription_policy_statements(schema: str) -> list[str]:
    return [
        re.sub(r"\s+", " ", match.group()).strip()
        for match in _SUBSCRIPTION_POLICY_STATEMENT_PATTERN.finditer(schema)
    ]


def test_schema_defines_auth_and_entitlement_tables_with_foreign_keys() -> None:
    schema = _read_schema()

    for table_name in (
        "profiles",
        "organizations",
        "memberships",
        "features",
        "plans",
        "plan_features",
        "subscriptions",
    ):
        assert f"create table public.{table_name}" in schema

    for foreign_key in (
        "references auth.users(id)",
        "references public.organizations(id)",
        "references public.plans(id)",
        "references public.features(code)",
    ):
        assert foreign_key in schema


def test_schema_enforces_membership_uniqueness_and_indexes_foreign_keys() -> None:
    schema = _read_schema()

    assert "unique (organization_id, user_id)" in schema
    for index_name in (
        "idx_memberships_organization_id",
        "idx_memberships_user_id",
        "idx_plan_features_plan_id",
        "idx_plan_features_feature_code",
        "idx_subscriptions_organization_id",
        "idx_subscriptions_plan_id",
        "idx_subscriptions_active_lookup",
    ):
        assert f"create index {index_name}" in schema


def test_schema_enables_rls_and_uses_membership_based_policies() -> None:
    schema = _read_schema()

    for table_name in (
        "profiles",
        "organizations",
        "memberships",
        "features",
        "plans",
        "plan_features",
        "subscriptions",
    ):
        assert f"alter table public.{table_name} enable row level security" in schema

    assert "to authenticated" in schema
    assert "(select auth.uid())" in schema
    assert "'owner', 'admin'" in schema


def test_schema_bootstraps_the_creator_as_the_first_organization_owner() -> None:
    schema = _read_schema()

    assert "create function private.bootstrap_organization_owner" in schema
    assert "after insert on public.organizations" in schema
    assert "execute function private.bootstrap_organization_owner()" in schema
    assert "values (new.id, (select auth.uid()), 'owner')" in schema


def test_schema_reserves_subscription_mutation_for_the_trusted_server_path() -> None:
    schema = _read_schema()

    for action in ("insert", "update", "delete"):
        assert f"on public.subscriptions\nfor {action}\nto authenticated" not in schema
    assert "subscription mutations are reserved for the trusted server/platform path" in schema


def test_schema_rejects_all_subscription_policy_mutation_variants() -> None:
    schema = _read_schema()
    policy_statements = _subscription_policy_statements(schema)

    assert len(policy_statements) == 1
    assert _INTENDED_SUBSCRIPTION_POLICY_PATTERN.fullmatch(policy_statements[0])

    for forbidden_policy in (
        (
            'create policy "subscriptions_all" on public.subscriptions '
            "for all to authenticated using (true);"
        ),
        (
            'create policy "subscriptions_insert" on public.subscriptions '
            "for insert to authenticated with check (true);"
        ),
        (
            'create policy "subscriptions_public" on public.subscriptions '
            "for select to public using (true);"
        ),
        (
            "create policy subscriptions_all on public.subscriptions "
            "as permissive for all to authenticated using (true);"
        ),
        "create policy subscriptions_all on public.subscriptions;",
        "create policy subscriptions_all on public.subscriptions for all to public;",
    ):
        assert len(_subscription_policy_statements(f"{schema}\n{forbidden_policy}")) == 2


def test_seed_defines_required_plans_and_feature_codes() -> None:
    seed = _read_seed()

    for plan_code in ("basic", "standard", "pro"):
        assert f"'{plan_code}'" in seed
    for feature_code in (
        "dashboard.basic",
        "crm.basic",
        "document.template",
        "data.basic",
        "reports.basic",
        "automation.custom",
        "ai.summary",
    ):
        assert f"'{feature_code}'" in seed


def test_hardening_enforces_one_active_subscription_per_organization() -> None:
    hardening = _read_hardening()

    assert "create unique index idx_subscriptions_one_active_per_organization" in hardening
    assert "on public.subscriptions (organization_id)" in hardening
    assert "where status in ('trialing', 'active')" in hardening


def test_hardening_exposes_only_authenticated_existence_rpc_with_auth_guard() -> None:
    hardening = _read_hardening()

    assert "create function public.organization_exists(target_organization_id uuid)" in hardening
    assert "security definer" in hardening
    assert "set search_path = ''" in hardening
    assert "if (select auth.uid()) is null then" in hardening
    assert "revoke all on function public.organization_exists(uuid) from public" in hardening
    assert (
        "grant execute on function public.organization_exists(uuid) to authenticated" in hardening
    )


def test_admin_subscription_rpc_is_atomic_and_service_role_only() -> None:
    migration = _read_admin_migration()

    assert "create function public.replace_organization_subscription" in migration
    assert "security definer" in migration
    assert "set search_path = ''" in migration
    assert "delete from public.subscriptions" in migration
    assert "insert into public.subscriptions" in migration
    assert "revoke all on function public.replace_organization_subscription" in migration
    assert "from public" in migration
    assert "from anon" in migration
    assert "from authenticated" in migration
    assert "grant execute on function public.replace_organization_subscription" in migration
    assert "to service_role" in migration


def test_crm_customers_schema_is_tenant_scoped_and_indexed() -> None:
    migration = _read_crm_migration()

    assert "create table public.customers" in migration
    assert (
        "organization_id uuid not null references public.organizations(id) on delete cascade"
        in migration
    )
    assert "email text" in migration
    assert "phone text" in migration
    assert "notes text not null default ''" in migration
    assert (
        "create index idx_customers_organization_id on public.customers (organization_id)"
        in migration
    )


def test_crm_customers_uses_member_read_and_manager_mutation_rls() -> None:
    migration = _read_crm_migration()

    assert "alter table public.customers enable row level security" in migration
    assert 'create policy "customers_select_member"' in migration
    assert "for select\nto authenticated" in migration
    assert "array['owner', 'admin', 'member']::text[]" in migration
    for action in ("insert", "update", "delete"):
        assert f'create policy "customers_{action}_manager"' in migration
    assert "array['owner', 'admin']::text[]" in migration


def test_tasks_schema_and_rls_are_organization_scoped() -> None:
    migration = _read_tasks_migration()
    assert "create table public.tasks" in migration
    assert "created_by uuid not null references auth.users(id)" in migration
    assert "status text not null default 'open'" in migration
    assert "priority text not null default 'normal'" in migration
    assert "create index idx_tasks_organization_status" in migration
    assert "alter table public.tasks enable row level security" in migration
    assert 'create policy "tasks_select_member"' in migration
    assert 'create policy "tasks_update_creator_or_manager"' in migration
    assert "create function private.prevent_task_tenant_change" in migration
    assert "new.organization_id is distinct from old.organization_id" in migration
    assert "new.created_by is distinct from old.created_by" in migration
    assert "create trigger tasks_prevent_tenant_change before update on public.tasks" in migration
    assert "execute function private.prevent_task_tenant_change()" in migration


def test_documents_schema_is_tenant_scoped_and_indexed() -> None:
    migration = _read_documents_migration()
    for table_name in ("document_templates", "documents"):
        assert f"create table public.{table_name}" in migration
        assert f"alter table public.{table_name} enable row level security" in migration
        assert f"create index idx_{table_name}_organization_updated" in migration

    assert "template_id uuid references public.document_templates(id)" in migration
    assert "status text not null default 'draft'" in migration
    assert "check (status in ('draft', 'final', 'archived'))" in migration
    assert "created_by uuid not null references auth.users(id)" in migration


def test_documents_rls_allows_member_reads_and_manager_mutations() -> None:
    migration = _read_documents_migration()
    for table_name in ("document_templates", "documents"):
        assert f'create policy "{table_name}_select_member"' in migration
        assert f'create policy "{table_name}_insert_manager"' in migration
        assert f'create policy "{table_name}_update_manager"' in migration
        assert "array['owner', 'admin', 'member']::text[]" in migration
        assert "array['owner', 'admin']::text[]" in migration

    assert "document_template_same_organization" in migration


def test_documents_reject_tenant_changes_with_before_update_triggers() -> None:
    migration = _read_documents_migration()
    for table_name in ("document_templates", "documents"):
        assert f"prevent_{table_name}_tenant_change" in migration
        assert f"create trigger {table_name}_prevent_tenant_change before update on public.{table_name}" in migration
        assert "new.organization_id is distinct from old.organization_id" in migration
        assert "new.created_by is distinct from old.created_by" in migration
