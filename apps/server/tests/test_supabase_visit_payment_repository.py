import asyncio
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_visit_payments import (
    SupabaseVisitPaymentRepository,
)
from business_assistant_server.ports.repositories import RepositoryUnavailableError
from test_visit_payment_api import OP, ORGANIZATION_ID, RESULT, VISIT, payload


def run_response(response):
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=response)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseVisitPaymentRepository(
                "https://example.supabase.co", "public", "token", client
            )
            return await repo.get_payments(ORGANIZATION_ID, VISIT)

    return asyncio.run(run()), calls


def test_payment_read_uses_one_scoped_rpc():
    import json

    result, calls = run_response(RESULT)
    assert result.outstanding_amount == 100000
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/rpc/get_visit_payments")
    assert calls[0].headers["Authorization"] == "Bearer token"
    assert json.loads(calls[0].content) == {
        "p_organization_id": str(ORGANIZATION_ID),
        "p_visit_id": str(VISIT),
    }


@pytest.mark.parametrize("change", ["visit", "balance", "receipts"])
def test_inconsistent_payment_response_fails_closed(change):
    result = deepcopy(RESULT)
    if change == "visit":
        result["visit_id"] = str(uuid4())
    elif change == "balance":
        result["paid_amount"] = "1"
    else:
        result["paid_amount"] = "1"
        result["outstanding_amount"] = "99999"
    with pytest.raises(RepositoryUnavailableError):
        run_response(result)


def test_payment_write_preserves_request_identity_and_integer_strings():
    import json

    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=RESULT)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseVisitPaymentRepository(
                "https://example.supabase.co", "public", "token", client
            )
            return await repo.record_payment(
                ORGANIZATION_ID, VISIT, 3, OP, payload()["payments"], True
            )

    asyncio.run(run())
    sent = json.loads(calls[0].content)
    assert sent == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_visit_id=str(VISIT),
        p_expected_version=3,
        p_operation_id=str(OP),
        p_payments=payload()["payments"],
        p_confirmed=True,
    )


def test_payment_snapshot_accepts_wallet_usage_as_paid_amount():
    result = deepcopy(RESULT)
    result.update(paid_amount="30000", outstanding_amount="70000", status="collecting")
    result["receipts"] = [
        {
            "id": str(uuid4()),
            "method": "wallet",
            "amount": "30000",
            "reference": "VIP 금액권 · 금액",
            "received_at": "2026-10-07T10:00:00+09:00",
            "operation_id": str(uuid4()),
        }
    ]
    snapshot, _ = run_response(result)
    assert snapshot.receipts[0].method == "wallet"
    assert snapshot.outstanding_amount == 70000


def test_refund_write_preserves_original_source_and_reason():
    import json

    source = uuid4()
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=RESULT)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseVisitPaymentRepository(
                "https://example.supabase.co", "public", "token", client
            )
            return await repo.refund_payment(
                ORGANIZATION_ID, VISIT, source, "1000", "고객 요청", 3, OP, True
            )

    asyncio.run(run())
    assert calls[0].url.path.endswith("/rpc/refund_visit_payment")
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_visit_id=str(VISIT),
        p_source_id=str(source),
        p_amount="1000",
        p_reason="고객 요청",
        p_expected_cart_version=3,
        p_operation_id=str(OP),
        p_confirmed=True,
    )


def test_product_return_uses_one_atomic_rpc_with_receipt_and_stock_choice():
    import json

    line, receipt = uuid4(), uuid4()
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=RESULT)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseVisitPaymentRepository(
                "https://example.supabase.co", "public", "token", client
            )
            return await repo.return_product(
                ORGANIZATION_ID, VISIT, line, receipt, 2, False, "2000", "손상", 3, OP, True
            )

    asyncio.run(run())
    assert calls[0].url.path.endswith("/rpc/return_visit_product")
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_visit_id=str(VISIT),
        p_sale_line_id=str(line),
        p_receipt_id=str(receipt),
        p_quantity=2,
        p_restock=False,
        p_amount="2000",
        p_reason="손상",
        p_expected_cart_version=3,
        p_operation_id=str(OP),
        p_confirmed=True,
    )
