import asyncio
import json
from datetime import date
from decimal import Decimal
from uuid import UUID

import httpx
import pytest
from business_assistant_server.adapters.supabase_finance import SupabaseFinanceRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
USER_ID = UUID("12345678-1234-5678-1234-567812345678")
TRANSACTION_ID = UUID("33333333-3333-3333-3333-333333333333")


def test_finance_adapter_scopes_requests_and_preserves_decimal_amounts() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200 if request.method == "GET" else 201, json=[_row()])

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseFinanceRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            rows = await repository.list_transactions(
                ORGANIZATION_ID, date(2030, 1, 1), date(2030, 1, 31), "income"
            )
            assert rows[0].amount == Decimal("1234.50")
            await repository.create_transaction(
                ORGANIZATION_ID,
                USER_ID,
                {
                    "transaction_type": "income",
                    "amount": Decimal("1234.50"),
                    "transaction_date": date(2030, 1, 10),
                    "category": "Sales",
                },
            )
            await repository.update_transaction(
                ORGANIZATION_ID, TRANSACTION_ID, {"amount": Decimal("12.34")}
            )

    asyncio.run(run())
    assert all(request.headers["authorization"] == "Bearer user-token" for request in requests)
    assert all(request.headers["apikey"] == "publishable-key" for request in requests)
    assert requests[0].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert requests[0].url.params["and"] == (
        "(transaction_date.gte.2030-01-01,transaction_date.lte.2030-01-31)"
    )
    assert requests[0].url.params["transaction_type"] == "eq.income"
    assert json.loads(requests[1].content)["amount"] == "1234.50"
    assert json.loads(requests[2].content)["amount"] == "12.34"


def test_finance_adapter_calculates_summary_without_float_rounding() -> None:
    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200, json=[_row(), _row(amount="10.10", transaction_type="expense")]
                )
            )
        ) as client:
            repository = SupabaseFinanceRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            summary = await repository.summarize_transactions(ORGANIZATION_ID, None, None)
            assert summary.income_total == Decimal("1234.50")
            assert summary.expense_total == Decimal("10.10")
            assert summary.net_total == Decimal("1224.40")
            assert summary.transaction_count == 2

    asyncio.run(run())


def test_finance_adapter_maps_provider_errors_safely() -> None:
    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500, text="secret"))
        ) as client:
            repository = SupabaseFinanceRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            with pytest.raises(RepositoryUnavailableError):
                await repository.list_transactions(ORGANIZATION_ID, None, None, None)

    asyncio.run(run())


def _row(*, amount: str = "1234.50", transaction_type: str = "income") -> dict[str, object]:
    return {
        "id": str(TRANSACTION_ID),
        "organization_id": str(ORGANIZATION_ID),
        "created_by": str(USER_ID),
        "transaction_type": transaction_type,
        "amount": amount,
        "transaction_date": "2030-01-10",
        "category": "Sales",
        "counterparty": "Acme",
        "memo": "Invoice",
        "is_archived": False,
        "created_at": "2030-01-10T00:00:00+00:00",
        "updated_at": "2030-01-10T00:00:00+00:00",
    }
