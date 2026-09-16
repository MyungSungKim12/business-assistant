import asyncio
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.finance import get_finance_repository
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import (
    FinanceSummary,
    FinanceTransactionSummary,
    RepositoryUnavailableError,
    SubscriptionSummary,
)

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
OUTSIDER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
TRANSACTION_ID = UUID("33333333-3333-3333-3333-333333333333")


class FakeAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token == "owner-token":
            return AuthUser(OWNER_ID, "owner@example.com", "Owner")
        if access_token == "outsider-token":
            return AuthUser(OUTSIDER_ID, "outsider@example.com", "Outsider")
        raise AuthenticationError()


class FakeOrganizationRepository:
    def __init__(self, features: list[str] | None = None, role: str | None = "owner") -> None:
        self.features = ["finance.basic"] if features is None else features
        self.role = role

    async def organization_exists(self, organization_id: UUID) -> bool:
        return organization_id == ORGANIZATION_ID

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        if user_id == OWNER_ID and organization_id == ORGANIZATION_ID:
            return self.role
        return None

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        del now
        return SubscriptionSummary(
            organization_id,
            "BASIC",
            "active",
            datetime.now(UTC) + timedelta(days=1),
            self.features,
        )


class FakeFinanceRepository:
    def __init__(self) -> None:
        self.transactions = {
            TRANSACTION_ID: FinanceTransactionSummary(
                TRANSACTION_ID,
                ORGANIZATION_ID,
                OWNER_ID,
                "income",
                Decimal("100.00"),
                "2030-01-10",
                "Sales",
                "Acme",
                "Invoice",
                False,
                "2030-01-10T00:00:00+00:00",
                "2030-01-10T00:00:00+00:00",
            )
        }

    async def list_transactions(
        self,
        organization_id: UUID,
        from_date: date | None,
        to_date: date | None,
        transaction_type: str | None,
    ) -> list[FinanceTransactionSummary]:
        return [
            item
            for item in self.transactions.values()
            if item.organization_id == organization_id
            and (from_date is None or date.fromisoformat(item.transaction_date) >= from_date)
            and (to_date is None or date.fromisoformat(item.transaction_date) <= to_date)
            and (transaction_type is None or item.transaction_type == transaction_type)
        ]

    async def create_transaction(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary:
        transaction = FinanceTransactionSummary(
            uuid4(),
            organization_id,
            created_by,
            str(values["transaction_type"]),
            Decimal(str(values["amount"])),
            str(values["transaction_date"]),
            str(values["category"]),
            str(values.get("counterparty", "")),
            str(values.get("memo", "")),
            bool(values.get("is_archived", False)),
            "2030-01-10T00:00:00+00:00",
            "2030-01-10T00:00:00+00:00",
        )
        self.transactions[transaction.id] = transaction
        return transaction

    async def update_transaction(
        self, organization_id: UUID, transaction_id: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary | None:
        transaction = self.transactions.get(transaction_id)
        if transaction is None or transaction.organization_id != organization_id:
            return None
        updated = FinanceTransactionSummary(
            transaction.id,
            transaction.organization_id,
            transaction.created_by,
            str(values.get("transaction_type", transaction.transaction_type)),
            Decimal(str(values.get("amount", transaction.amount))),
            str(values.get("transaction_date", transaction.transaction_date)),
            str(values.get("category", transaction.category)),
            str(values.get("counterparty", transaction.counterparty)),
            str(values.get("memo", transaction.memo)),
            bool(values.get("is_archived", transaction.is_archived)),
            transaction.created_at,
            "2030-01-11T00:00:00+00:00",
        )
        self.transactions[transaction_id] = updated
        return updated

    async def summarize_transactions(
        self, organization_id: UUID, from_date: date | None, to_date: date | None
    ) -> FinanceSummary:
        rows = await self.list_transactions(organization_id, from_date, to_date, None)
        income = sum((row.amount for row in rows if row.transaction_type == "income"), Decimal(0))
        expense = sum((row.amount for row in rows if row.transaction_type == "expense"), Decimal(0))
        return FinanceSummary(income, expense, income - expense, len(rows))


class UnavailableFinanceRepository(FakeFinanceRepository):
    async def list_transactions(
        self,
        organization_id: UUID,
        from_date: date | None,
        to_date: date | None,
        transaction_type: str | None,
    ) -> list[FinanceTransactionSummary]:
        del organization_id, from_date, to_date, transaction_type
        raise RepositoryUnavailableError()


def _request(
    method: str,
    path: str,
    *,
    organization_repository: FakeOrganizationRepository | None = None,
    finance_repository: FakeFinanceRepository | None = None,
    token: str | None = "owner-token",
    json: object = None,
    params: dict[str, str] | None = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: (
            organization_repository or FakeOrganizationRepository()
        )
        app.dependency_overrides[get_finance_repository] = lambda: (
            finance_repository or FakeFinanceRepository()
        )
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            return await client.request(method, path, headers=headers, json=json, params=params)

    return asyncio.run(send())


def _path(kind: str = "finance-transactions", organization_id: UUID = ORGANIZATION_ID) -> str:
    return f"/api/v1/organizations/{organization_id}/{kind}"


def test_finance_requires_auth_membership_and_feature() -> None:
    assert _request("GET", _path(), token=None).status_code == 401
    assert _request("GET", _path(), token="outsider-token").status_code == 403
    assert (
        _request("GET", _path(), organization_repository=FakeOrganizationRepository([])).status_code
        == 403
    )


def test_finance_crud_filters_and_summary() -> None:
    repository = FakeFinanceRepository()
    created = _request(
        "POST",
        _path(),
        finance_repository=repository,
        json={
            "transaction_type": "expense",
            "amount": "25.50",
            "transaction_date": "2030-01-12",
            "category": "Supplies",
        },
    )
    assert created.status_code == 201
    listed = _request(
        "GET", _path(), finance_repository=repository, params={"transaction_type": "income"}
    )
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    summary = _request("GET", _path("finance-summary"), finance_repository=repository)
    assert summary.status_code == 200
    assert summary.json()["income_total"] == "100.00"
    assert summary.json()["expense_total"] == "25.50"
    updated = _request(
        "PATCH",
        f"{_path()}/{created.json()['id']}",
        finance_repository=repository,
        json={"is_archived": True},
    )
    assert updated.status_code == 200
    assert updated.json()["is_archived"] is True


def test_finance_validates_input_and_manager_role() -> None:
    repository = FakeFinanceRepository()
    for payload in (
        {
            "transaction_type": "other",
            "amount": "1",
            "transaction_date": "2030-01-01",
            "category": "X",
        },
        {
            "transaction_type": "income",
            "amount": "0",
            "transaction_date": "2030-01-01",
            "category": "X",
        },
        {
            "transaction_type": "income",
            "amount": "1",
            "transaction_date": "2030-01-01",
            "category": "",
        },
    ):
        assert (
            _request("POST", _path(), finance_repository=repository, json=payload).status_code
            == 422
        )
    assert (
        _request(
            "POST",
            _path(),
            organization_repository=FakeOrganizationRepository(role="member"),
            finance_repository=repository,
            json={
                "transaction_type": "income",
                "amount": "1",
                "transaction_date": "2030-01-01",
                "category": "X",
            },
        ).status_code
        == 403
    )


def test_finance_provider_error_is_safe() -> None:
    response = _request("GET", _path(), finance_repository=UnavailableFinanceRepository())
    assert response.status_code == 503
    assert response.json() == {"detail": "Finance service unavailable"}
