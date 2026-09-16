import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.customers import get_customer_repository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import (
    CustomerSummary,
    SubscriptionSummary,
)

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
OUTSIDER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_ORGANIZATION_ID = UUID("22222222-2222-2222-2222-222222222222")
CUSTOMER_ID = UUID("33333333-3333-3333-3333-333333333333")


class FakeAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token == "owner-token":
            return AuthUser(OWNER_ID, "owner@example.com", "Owner")
        if access_token == "outsider-token":
            return AuthUser(OUTSIDER_ID, "outsider@example.com", "Outsider")
        raise AuthenticationError()


class FakeOrganizationRepository:
    def __init__(self, features: list[str] | None = None) -> None:
        self.features = ["crm.basic"] if features is None else features

    async def organization_exists(self, organization_id: UUID) -> bool:
        return organization_id == ORGANIZATION_ID

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        if user_id == OWNER_ID and organization_id == ORGANIZATION_ID:
            return "owner"
        return None

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        del now
        if organization_id != ORGANIZATION_ID:
            return None
        return SubscriptionSummary(
            organization_id, "BASIC", "active", datetime.now(UTC) + timedelta(days=1), self.features
        )


class FakeCustomerRepository:
    def __init__(self) -> None:
        self.customers = {
            CUSTOMER_ID: CustomerSummary(
                CUSTOMER_ID,
                ORGANIZATION_ID,
                "Hana Kim",
                "hana@example.com",
                "010-1234-5678",
                "Priority customer",
            )
        }

    async def list_customers(self, organization_id: UUID) -> list[CustomerSummary]:
        return [item for item in self.customers.values() if item.organization_id == organization_id]

    async def create_customer(
        self,
        organization_id: UUID,
        name: str,
        email: str | None,
        phone: str | None,
        notes: str,
    ) -> CustomerSummary:
        customer = CustomerSummary(uuid4(), organization_id, name, email, phone, notes)
        self.customers[customer.id] = customer
        return customer

    async def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> CustomerSummary | None:
        customer = self.customers.get(customer_id)
        if customer is None or customer.organization_id != organization_id:
            return None
        updated = CustomerSummary(
            customer.id,
            customer.organization_id,
            values.get("name", customer.name) or customer.name,
            values.get("email", customer.email),
            values.get("phone", customer.phone),
            values.get("notes", customer.notes) or "",
        )
        self.customers[customer.id] = updated
        return updated

    async def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool:
        customer = self.customers.get(customer_id)
        if customer is None or customer.organization_id != organization_id:
            return False
        del self.customers[customer_id]
        return True


class UnavailableCustomerRepository(FakeCustomerRepository):
    async def list_customers(self, organization_id: UUID) -> list[CustomerSummary]:
        from business_assistant_server.ports.repositories import RepositoryUnavailableError

        raise RepositoryUnavailableError()


def _request(
    method: str,
    path: str,
    *,
    organization_repository: FakeOrganizationRepository | None = None,
    customer_repository: FakeCustomerRepository | None = None,
    token: str | None = "owner-token",
    json: object = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: (
            organization_repository or FakeOrganizationRepository()
        )
        app.dependency_overrides[get_customer_repository] = lambda: (
            customer_repository or FakeCustomerRepository()
        )
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, path, headers=headers, json=json)

    return asyncio.run(send())


def _customers_path(organization_id: UUID = ORGANIZATION_ID) -> str:
    return f"/api/v1/organizations/{organization_id}/customers"


def test_customers_require_authentication() -> None:
    assert _request("GET", _customers_path(), token=None).status_code == 401


def test_customers_reject_non_member() -> None:
    assert _request("GET", _customers_path(), token="outsider-token").status_code == 403


def test_customers_require_crm_feature() -> None:
    response = _request(
        "GET", _customers_path(), organization_repository=FakeOrganizationRepository([])
    )
    assert response.status_code == 403
    assert response.json()["feature_code"] == "crm.basic"


def test_customer_crud_validates_and_scopes_organization() -> None:
    repository = FakeCustomerRepository()
    invalid = _request("POST", _customers_path(), customer_repository=repository, json={"name": ""})
    assert invalid.status_code == 422

    created = _request(
        "POST",
        _customers_path(),
        customer_repository=repository,
        json={"name": "  Min Park  ", "email": "min@example.com", "notes": "New lead"},
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Min Park"
    assert created.json()["phone"] is None
    created_id = UUID(created.json()["id"])

    patched = _request(
        "PATCH",
        f"{_customers_path()}/{created_id}",
        customer_repository=repository,
        json={"phone": "010-0000-0000"},
    )
    assert patched.status_code == 200
    assert patched.json()["phone"] == "010-0000-0000"

    wrong_organization = _request(
        "DELETE",
        f"{_customers_path(OTHER_ORGANIZATION_ID)}/{created_id}",
        customer_repository=repository,
    )
    assert wrong_organization.status_code == 404
    assert created_id in repository.customers

    deleted = _request(
        "DELETE", f"{_customers_path()}/{created_id}", customer_repository=repository
    )
    assert deleted.status_code == 204
    assert created_id not in repository.customers


def test_customer_provider_failure_is_mapped_safely() -> None:
    response = _request(
        "GET", _customers_path(), customer_repository=UnavailableCustomerRepository()
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Customer service unavailable"}
