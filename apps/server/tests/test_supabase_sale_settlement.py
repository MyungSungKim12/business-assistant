import asyncio
import json
from datetime import date
from uuid import UUID

import httpx
from business_assistant_server.adapters.supabase_sale_settlement import (
    SupabaseSaleSettlementRepository,
)

ORG = UUID("11111111-1111-1111-1111-111111111111")
DAY = date(2026, 10, 8)
PAYLOAD = {
    "organization_id": str(ORG),
    "business_date": DAY.isoformat(),
    "cash_received": 100,
    "cash_refunded": 0,
    "expected_cash": 100,
    "card_received": 0,
    "card_refunded": 0,
    "transfer_received": 0,
    "transfer_refunded": 0,
    "receipt_count": 1,
    "refund_count": 0,
    "receivables": [],
    "is_closed": False,
    "close": None,
}


def test_rpc_paths_and_parameters_are_scoped_and_versioned():
    requests = []

    def provider(request):
        requests.append(request)
        return httpx.Response(200, json=PAYLOAD)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseSaleSettlementRepository(
                "https://example.supabase.co", "public", "token", client
            )
            await repo.get_daily_settlement(ORG, DAY)
            await repo.close_day(ORG, DAY, "100", "확인", UUID(int=1), True)
            await repo.adjust_close(ORG, DAY, 2, "90", "정정", UUID(int=2), True)

    asyncio.run(run())
    assert [request.url.path.rsplit("/", 1)[-1] for request in requests] == [
        "get_sale_daily_settlement",
        "close_sale_daily",
        "adjust_sale_daily_close",
    ]
    assert json.loads(requests[2].content)["p_expected_version"] == 2
    assert all(request.headers["authorization"] == "Bearer token" for request in requests)


def test_repository_rejects_payload_for_other_organization_or_day():
    def provider(request):
        return httpx.Response(200, json={**PAYLOAD, "organization_id": str(UUID(int=9))})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseSaleSettlementRepository(
                "https://example.supabase.co", "public", "token", client
            )
            await repo.get_daily_settlement(ORG, DAY)

    from business_assistant_server.ports.repositories import RepositoryUnavailableError

    with __import__("pytest").raises(RepositoryUnavailableError):
        asyncio.run(run())
