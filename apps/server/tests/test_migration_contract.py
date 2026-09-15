import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = PROJECT_ROOT / "migrations" / "001_auth_entitlements.sql"
SEED_PATH = PROJECT_ROOT / "migrations" / "002_seed_entitlements.sql"
_SUBSCRIPTION_POLICY_PATTERN = re.compile(
    r'create\s+policy\s+"(?P<name>[^"]+)"\s+'
    r"on\s+public\.subscriptions\s+"
    r"(?:for\s+(?P<action>all|select|insert|update|delete)\s+)?"
    r"(?:to\s+(?P<role>[a-z_]+)\s+)?",
    re.IGNORECASE,
)


def _read_schema() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8").lower()


def _read_seed() -> str:
    return SEED_PATH.read_text(encoding="utf-8").lower()


def _subscription_policy_declarations(schema: str) -> list[tuple[str, str, str]]:
    return [
        (
            match.group("name"),
            match.group("action") or "all",
            match.group("role") or "public",
        )
        for match in _SUBSCRIPTION_POLICY_PATTERN.finditer(schema)
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
    expected_policy = [("subscriptions_select_member", "select", "authenticated")]

    assert _subscription_policy_declarations(schema) == expected_policy

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
    ):
        assert _subscription_policy_declarations(f"{schema}\n{forbidden_policy}") != expected_policy


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
