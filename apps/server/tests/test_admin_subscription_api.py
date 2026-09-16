import asyncio
from uuid import UUID

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.admin import (
    AdminSubscriptionNotFoundError,
    get_admin_subscription_repository,
)
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    AuthenticationError,
    get_auth_adapter,
    get_settings,
)
from business_assistant_server.main import create_app

ADMIN_ID = UUID("12345678-1234-5678-1234-567812345678")
USER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeAuthAdapter:
    async def verify_access_token(self, token: str) -> AuthUser:
        if token == "admin":
            return AuthUser(ADMIN_ID, "admin@example.com", "Admin")
        if token == "user":
            return AuthUser(USER_ID, "user@example.com", "User")
        raise AuthenticationError()


class FakeAdminRepository:
    async def replace_subscription(self, organization_id: UUID, request: object) -> object:
        return request


class MissingOrganizationRepository:
    async def replace_subscription(self, organization_id: UUID, request: object) -> object:
        raise AdminSubscriptionNotFoundError()


def _configured_settings() -> Settings:
    return Settings(
        _env_file=None,
        supabase_url="https://project.supabase.co",
        supabase_service_key="server-secret",
        platform_admin_user_ids=frozenset({ADMIN_ID}),
    )


def _request(
    token: str | None,
    settings: Settings,
    subscription_status: str = "active",
    plan_code: str = "BASIC",
    ends_at: str | None = None,
    starts_at: str = "2026-09-16T00:00:00Z",
    repository_type: type = FakeAdminRepository,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_settings] = lambda: settings
        if settings.supabase_service_key is not None:
            app.dependency_overrides[get_admin_subscription_repository] = repository_type
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.post(
                f"/api/v1/admin/organizations/{ORGANIZATION_ID}/subscription",
                headers=headers,
                json={
                    "plan_code": plan_code,
                    "status": subscription_status,
                    "starts_at": starts_at,
                    "ends_at": ends_at,
                },
            )

    return asyncio.run(send())


def test_admin_subscription_requires_authentication() -> None:
    assert (
        _request(
            None, Settings(_env_file=None, platform_admin_user_ids=frozenset({ADMIN_ID}))
        ).status_code
        == 401
    )


def test_admin_subscription_rejects_non_platform_admin() -> None:
    assert (
        _request(
            "user",
            Settings(
                _env_file=None,
                supabase_url="https://project.supabase.co",
                supabase_service_key="server-secret",
                platform_admin_user_ids=frozenset({ADMIN_ID}),
            ),
        ).status_code
        == 403
    )


def test_admin_subscription_requires_server_configuration() -> None:
    assert (
        _request(
            "admin", Settings(_env_file=None, platform_admin_user_ids=frozenset({ADMIN_ID}))
        ).status_code
        == 503
    )


def test_admin_subscription_accepts_valid_platform_admin_request() -> None:
    settings = Settings(
        _env_file=None,
        supabase_url="https://project.supabase.co",
        supabase_service_key="server-secret",
        platform_admin_user_ids=frozenset({ADMIN_ID}),
    )
    response = _request("admin", settings, plan_code="  basic  ")
    assert response.status_code == 200
    assert response.json()["plan_code"] == "BASIC"


def test_admin_subscription_rejects_non_positive_window() -> None:
    settings = Settings(
        _env_file=None,
        supabase_url="https://project.supabase.co",
        supabase_service_key="server-secret",
        platform_admin_user_ids=frozenset({ADMIN_ID}),
    )
    assert _request("admin", settings, ends_at="2026-09-16T00:00:00Z").status_code == 422


def test_admin_subscription_rejects_naive_and_aware_datetime_mix() -> None:
    settings = _configured_settings()
    response = _request(
        "admin",
        settings,
        ends_at="2026-09-17T00:00:00Z",
        starts_at="2026-09-16T00:00:00",
    )
    assert response.status_code == 422
    assert "timezone-aware" in response.text


def test_admin_subscription_maps_repository_not_found_to_404() -> None:
    settings = _configured_settings()
    assert (
        _request("admin", settings, repository_type=MissingOrganizationRepository).status_code
        == 404
    )


def test_admin_subscription_rejects_invalid_status() -> None:
    settings = Settings(
        _env_file=None,
        supabase_url="https://project.supabase.co",
        supabase_service_key="server-secret",
        platform_admin_user_ids=frozenset({ADMIN_ID}),
    )
    response = _request("admin", settings, "unknown")
    assert response.status_code == 422


def test_admin_subscription_normalizes_whitespace_plan_code() -> None:
    settings = Settings(
        _env_file=None,
        supabase_url="https://project.supabase.co",
        supabase_service_key="server-secret",
        platform_admin_user_ids=frozenset({ADMIN_ID}),
    )
    response = _request("admin", settings, plan_code="  basic  ")
    assert response.status_code == 200
    assert response.json()["plan_code"] == "BASIC"
