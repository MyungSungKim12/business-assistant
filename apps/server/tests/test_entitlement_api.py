import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import (
    MemberSummary,
    OrganizationSummary,
    SubscriptionSummary,
)

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
MEMBER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
UNKNOWN_ORGANIZATION_ID = UUID("22222222-2222-2222-2222-222222222222")


class FakeAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token == "owner-token":
            return AuthUser(OWNER_ID, "owner@example.com", "Owner")
        if access_token == "member-token":
            return AuthUser(MEMBER_ID, "member@example.com", "Member")
        raise AuthenticationError()


class FakeRepository:
    def __init__(self) -> None:
        self.organization = OrganizationSummary(ORGANIZATION_ID, "Hana Studio", "hana", "owner")
        self.memberships = {(OWNER_ID, ORGANIZATION_ID): "owner"}
        self.subscription: SubscriptionSummary | None = None

    async def create_organization(self, user_id: UUID, name: str, slug: str) -> OrganizationSummary:
        organization = OrganizationSummary(uuid4(), name, slug, "owner")
        self.organization = organization
        self.memberships[(user_id, organization.id)] = "owner"
        return organization

    async def list_organizations_for_user(self, user_id: UUID) -> list[OrganizationSummary]:
        if (user_id, self.organization.id) not in self.memberships:
            return []
        return [self.organization]

    async def get_organization(self, organization_id: UUID) -> OrganizationSummary | None:
        return self.organization if self.organization.id == organization_id else None

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        return self.memberships.get((user_id, organization_id))

    async def list_members(self, organization_id: UUID) -> list[MemberSummary]:
        return [
            MemberSummary(user_id=user_id, role=role)
            for (user_id, current_organization_id), role in self.memberships.items()
            if current_organization_id == organization_id
        ]

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        if self.subscription is None or self.subscription.organization_id != organization_id:
            return None
        if self.subscription.status not in {"trialing", "active"}:
            return None
        if self.subscription.ends_at is not None and self.subscription.ends_at <= now:
            return None
        return self.subscription


def _request(
    method: str,
    path: str,
    *,
    repository: FakeRepository,
    token: str | None = "owner-token",
    json: object = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: repository
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, path, headers=headers, json=json)

    return asyncio.run(send())


def test_organizations_require_bearer_authentication() -> None:
    response = _request("GET", "/api/v1/organizations", repository=FakeRepository(), token=None)

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_owner_can_create_an_organization_and_is_returned_as_owner() -> None:
    response = _request(
        "POST",
        "/api/v1/organizations",
        repository=FakeRepository(),
        json={"name": "New Studio", "slug": "new-studio"},
    )

    assert response.status_code == 201
    assert response.json() == {
        "id": response.json()["id"],
        "name": "New Studio",
        "slug": "new-studio",
        "role": "owner",
    }


def test_non_member_cannot_view_entitlements() -> None:
    response = _request(
        "GET",
        f"/api/v1/organizations/{ORGANIZATION_ID}/entitlements",
        repository=FakeRepository(),
        token="member-token",
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Organization membership required"}


def test_entitlements_return_404_for_a_nonexistent_organization() -> None:
    response = _request(
        "GET",
        f"/api/v1/organizations/{UNKNOWN_ORGANIZATION_ID}/entitlements",
        repository=FakeRepository(),
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Organization not found"}


def test_entitlements_return_empty_features_without_subscription() -> None:
    response = _request(
        "GET", f"/api/v1/organizations/{ORGANIZATION_ID}/entitlements", repository=FakeRepository()
    )

    assert response.status_code == 200
    assert response.json() == {
        "organization_id": str(ORGANIZATION_ID),
        "plan_code": None,
        "features": [],
    }


def test_current_subscription_returns_basic_features() -> None:
    repository = FakeRepository()
    repository.subscription = SubscriptionSummary(
        ORGANIZATION_ID,
        "BASIC",
        "active",
        datetime(2030, 1, 2, tzinfo=UTC),
        ["dashboard.basic", "crm.basic"],
    )

    response = _request(
        "GET",
        f"/api/v1/organizations/{ORGANIZATION_ID}/subscriptions/current",
        repository=repository,
    )

    assert response.status_code == 200
    assert response.json() == {
        "organization_id": str(ORGANIZATION_ID),
        "plan_code": "BASIC",
        "status": "active",
        "ends_at": "2030-01-02T00:00:00Z",
        "features": ["crm.basic", "dashboard.basic"],
    }


def test_current_subscription_returns_404_without_an_active_subscription() -> None:
    response = _request(
        "GET",
        f"/api/v1/organizations/{ORGANIZATION_ID}/subscriptions/current",
        repository=FakeRepository(),
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Active subscription not found"}


def test_require_feature_rejects_an_entitled_member_missing_the_requested_feature() -> None:
    from business_assistant_server.api.entitlements import require_feature
    from fastapi import APIRouter, Depends

    repository = FakeRepository()
    repository.subscription = SubscriptionSummary(
        ORGANIZATION_ID,
        "BASIC",
        "active",
        datetime.now(UTC) + timedelta(days=1),
        ["dashboard.basic", "crm.basic"],
    )
    app = create_app()
    protected = APIRouter()

    @protected.get("/protected/{organization_id}")
    async def protected_endpoint(
        _: object = Depends(require_feature("reports.basic")),
    ) -> dict[str, bool]:
        return {"allowed": True}

    app.include_router(protected, prefix="/api/v1")
    app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
    app.dependency_overrides[get_organization_repository] = lambda: repository

    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.get(
                f"/api/v1/protected/{ORGANIZATION_ID}",
                headers={"Authorization": "Bearer owner-token"},
            )

    response = asyncio.run(send())

    assert response.status_code == 403
    assert response.json() == {"detail": "Feature not available", "feature_code": "reports.basic"}
