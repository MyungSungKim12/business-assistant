import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
from business_assistant_server.adapters.supabase_organizations import SupabaseOrganizationRepository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.config import Settings
from fastapi.security import HTTPAuthorizationCredentials

USER_ID = UUID("12345678-1234-5678-1234-567812345678")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")


def test_repository_uses_user_token_and_parses_organization_membership_rows() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/memberships"):
            return httpx.Response(
                200,
                json=[
                    {
                        "role": "owner",
                        "organizations": {
                            "id": str(ORGANIZATION_ID),
                            "name": "Hana",
                            "slug": "hana",
                        },
                    }
                ],
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseOrganizationRepository(
                "https://project.supabase.co", "publishable-key", "user-access-token", client
            )
            organizations = await repository.list_organizations_for_user(USER_ID)

        assert organizations[0].id == ORGANIZATION_ID
        assert organizations[0].role == "owner"
        assert organizations[0].name == "Hana"

    asyncio.run(run())

    request = requests[0]
    assert request.url.path == "/rest/v1/memberships"
    assert request.headers["apikey"] == "publishable-key"
    assert request.headers["authorization"] == "Bearer user-access-token"
    assert request.url.params["user_id"] == f"eq.{USER_ID}"


def test_repository_creates_organizations_and_calculates_active_subscription_features() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            assert request.url.path.endswith("/rpc/create_organization")
            assert json.loads(request.content) == {"target_name": "Hana", "target_slug": "hana"}
            return httpx.Response(
                201,
                json=[{"id": str(ORGANIZATION_ID), "name": "Hana", "slug": "hana"}],
            )
        return httpx.Response(
            200,
            json=[
                {
                    "status": "active",
                    "ends_at": "2030-01-02T00:00:00Z",
                    "plans": {
                        "code": "BASIC",
                        "plan_features": [
                            {"feature_code": "crm.basic"},
                            {"feature_code": "dashboard.basic"},
                        ],
                    },
                }
            ],
        )

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseOrganizationRepository(
                "https://project.supabase.co", "publishable-key", "user-access-token", client
            )
            created = await repository.create_organization(USER_ID, "Hana", "hana")
            subscription = await repository.get_active_subscription(
                ORGANIZATION_ID, datetime(2029, 1, 1, tzinfo=UTC)
            )

        assert created.role == "owner"
        assert subscription is not None
        assert subscription.plan_code == "BASIC"
        assert subscription.features == ["crm.basic", "dashboard.basic"]

    asyncio.run(run())

    subscription_request = requests[1]
    assert subscription_request.url.path == "/rest/v1/subscriptions"
    assert subscription_request.url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert subscription_request.url.params["status"] == "in.(trialing,active)"
    assert subscription_request.url.params["order"] == "starts_at.desc"
    assert subscription_request.url.params["limit"] == "1"


def test_repository_converts_postgrest_failures_without_provider_details() -> None:
    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(500, text="provider secret")
            )
        ) as client:
            repository = SupabaseOrganizationRepository(
                "https://project.supabase.co", "publishable-key", "user-access-token", client
            )
            try:
                await repository.get_organization(ORGANIZATION_ID)
            except Exception as error:
                assert type(error).__name__ == "RepositoryUnavailableError"
                assert str(error) == "Organization service unavailable"
            else:
                raise AssertionError("Expected an availability error")

    asyncio.run(run())


def test_repository_dependency_builds_a_user_token_scoped_supabase_adapter() -> None:
    repository = get_organization_repository(
        Settings(
            _env_file=None,
            supabase_url="https://project.supabase.co",
            supabase_publishable_key="publishable-key",
        ),
        HTTPAuthorizationCredentials(scheme="Bearer", credentials="user-access-token"),
    )

    assert isinstance(repository, SupabaseOrganizationRepository)


def test_repository_uses_existence_only_rpc_for_nonmember_safe_lookup() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=True)

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseOrganizationRepository(
                "https://project.supabase.co", "publishable-key", "user-access-token", client
            )
            assert await repository.organization_exists(ORGANIZATION_ID) is True

    asyncio.run(run())

    assert requests[0].url.path == "/rest/v1/rpc/organization_exists"
    assert json.loads(requests[0].content) == {"target_organization_id": str(ORGANIZATION_ID)}
