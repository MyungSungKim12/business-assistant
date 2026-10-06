import asyncio
import json
from uuid import UUID

import httpx
from business_assistant_server.adapters.supabase_sale_carts import (
    SupabaseSaleCartRepository,
)

ORG = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER = UUID("22222222-2222-2222-2222-222222222222")
VISIT = UUID("33333333-3333-3333-3333-333333333333")
CART = UUID("44444444-4444-4444-4444-444444444444")
DRAFT = UUID("55555555-5555-5555-5555-555555555555")
OP = UUID("66666666-6666-6666-6666-666666666666")
VISIT_ROW = {
    "id": str(VISIT),
    "organization_id": str(ORG),
    "customer_id": str(CUSTOMER),
    "appointment_id": None,
    "status": "open",
    "opened_at": "2030-01-01T00:00:00Z",
    "closed_at": None,
    "version": 1,
}
CART_ROW = {
    "id": str(CART),
    "organization_id": str(ORG),
    "visit_id": str(VISIT),
    "customer_id": str(CUSTOMER),
    "status": "draft",
    "version": 1,
    "subtotal": "0.00",
    "discount_total": "0.00",
    "total_amount": "0.00",
}
BUNDLE = {"visit": VISIT_ROW, "cart": CART_ROW, "lines": []}


def test_rpc_payloads_preserve_scope_version_and_operation() -> None:
    calls = []

    def provider(request):
        calls.append(request)
        return httpx.Response(200, json=BUNDLE)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseSaleCartRepository(
                "https://example.supabase.co", "public", "token", client
            )
            await repo.create_visit(ORG, CUSTOMER, OP)
            await repo.add_treatment_draft(ORG, VISIT, DRAFT, 4, OP)

    asyncio.run(run())
    assert calls[0].url.path.endswith("/rpc/create_customer_visit")
    assert json.loads(calls[0].content) == {
        "p_organization_id": str(ORG),
        "p_customer_id": str(CUSTOMER),
        "p_operation_id": str(OP),
    }
    assert calls[1].url.path.endswith("/rpc/add_treatment_draft_to_cart")
    assert json.loads(calls[1].content)["p_expected_version"] == 4
    assert calls[1].headers["authorization"] == "Bearer token"


def test_list_and_get_are_organization_scoped() -> None:
    calls = []

    def provider(request):
        calls.append(request)
        if request.url.path.endswith("/customer_visits"):
            return httpx.Response(
                200, json=[VISIT_ROW] if request.url.params.get("offset") == "0" else []
            )
        if request.url.path.endswith("/rpc/get_visit_sale_cart"):
            return httpx.Response(200, json=BUNDLE)
        return httpx.Response(200, json=[])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseSaleCartRepository(
                "https://example.supabase.co", "public", "token", client
            )
            visits = await repo.list_visits(ORG, CUSTOMER, "open")
            cart = await repo.get_cart(ORG, VISIT)
            return visits, cart

    visits, result = asyncio.run(run())
    assert visits[0].id == VISIT
    assert result.cart.total_amount == 0
    assert all(dict(call.url.params).get("organization_id") == f"eq.{ORG}" for call in calls[:-1])
    assert calls[-1].method == "POST"
    assert json.loads(calls[-1].content) == {
        "p_organization_id": str(ORG),
        "p_visit_id": str(VISIT),
    }
    assert len(calls) == 3
