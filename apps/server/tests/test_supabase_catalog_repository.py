import asyncio
import json
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_catalog import SupabaseCatalogRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError
from test_catalog_api import OP, ORGANIZATION_ID, PRODUCT, ROW, VALUES


def invoke(response, action="list"):
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=response)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseCatalogRepository(
                "https://example.supabase.co", "public", "token", client
            )
            if action == "save":
                return await repo.save_product(ORGANIZATION_ID, PRODUCT, 1, OP, VALUES)
            if action == "wallet":
                return await repo.use_wallet(
                    ORGANIZATION_ID,
                    PRODUCT,
                    uuid4(),
                    uuid4(),
                    "money",
                    "10",
                    3,
                    OP,
                    True,
                )
            if action == "wallet-lifecycle":
                return await repo.manage_wallet(
                    ORGANIZATION_ID, PRODUCT, PRODUCT, "pause", None, "고객 요청", 1, OP
                )
            if action == "stock-change":
                return await repo.change_stock(
                    ORGANIZATION_ID, PRODUCT, "stocktake", 5, "실사", 3, OP
                )
            if action == "stock-ledger":
                return await repo.list_stock_ledger(ORGANIZATION_ID, PRODUCT)
            return await repo.list_products(ORGANIZATION_ID)

    return asyncio.run(run()), calls


def test_list_uses_scoped_rpc_and_user_token():
    result, calls = invoke([ROW])
    assert result[0].sale_price == 30000
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/rpc/list_catalog_products")
    assert calls[0].headers["Authorization"] == "Bearer token"
    assert json.loads(calls[0].content) == dict(p_organization_id=str(ORGANIZATION_ID))


def test_save_preserves_idempotency_scope_and_version():
    _, calls = invoke(ROW, "save")
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_product_id=str(PRODUCT),
        p_expected_version=1,
        p_operation_id=str(OP),
        p_values=VALUES,
    )


@pytest.mark.parametrize(
    "change", ["organization", "duplicate", "negative_stock", "invalid_price", "shape"]
)
def test_bad_response_is_not_exposed(change):
    row = deepcopy(ROW)
    response = [row]
    if change == "organization":
        row["organization_id"] = str(uuid4())
    elif change == "duplicate":
        response.append(row)
    elif change == "negative_stock":
        row["stock_quantity"] = -1
    elif change == "invalid_price":
        row["sale_price"] = "NaN"
    else:
        response = {}
    with pytest.raises(RepositoryUnavailableError):
        invoke(response)


def test_wrong_product_mutation_response_fails_closed():
    row = {**ROW, "id": str(uuid4())}
    with pytest.raises(RepositoryUnavailableError):
        invoke(row, "save")


def test_stock_change_sends_expected_version_and_operation():
    _, calls = invoke(ROW, "stock-change")
    assert calls[0].url.path.endswith("/rpc/change_catalog_stock")
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_product_id=str(PRODUCT),
        p_kind="stocktake",
        p_quantity=5,
        p_reason="실사",
        p_expected_version=3,
        p_operation_id=str(OP),
    )


def test_stock_ledger_rejects_cross_organization_rows():
    row = dict(
        id=str(uuid4()),
        organization_id=str(uuid4()),
        product_id=str(PRODUCT),
        movement_kind="disposal",
        quantity=-1,
        reason="폐기",
        created_by=str(uuid4()),
        created_at="2026-10-08T00:00:00Z",
    )
    with pytest.raises(RepositoryUnavailableError):
        invoke([row], "stock-ledger")


def test_stock_ledger_validates_movement_shape():
    row = dict(
        id=str(uuid4()),
        organization_id=str(ORGANIZATION_ID),
        product_id=str(PRODUCT),
        movement_kind="supplier_return",
        quantity=-2,
        reason="거래처 반품",
        created_by=str(uuid4()),
        created_at="2026-10-08T00:00:00Z",
    )
    result, _ = invoke([row], "stock-ledger")
    assert result[0].quantity == -2
    assert result[0].movement_kind == "supplier_return"


def test_wallet_usage_sends_scoped_atomic_request():
    from test_visit_payment_api import RESULT

    visit, wallet, line = uuid4(), uuid4(), uuid4()
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json={**RESULT, "visit_id": str(visit)})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repo = SupabaseCatalogRepository(
                "https://example.supabase.co", "public", "token", client
            )
            return await repo.use_wallet(
                ORGANIZATION_ID, visit, wallet, line, "count", None, 7, OP, True
            )

    result = asyncio.run(run())
    assert result.visit_id == visit
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID),
        p_visit_id=str(visit),
        p_wallet_id=str(wallet),
        p_sale_line_id=str(line),
        p_mode="count",
        p_amount=None,
        p_expected_cart_version=7,
        p_operation_id=str(OP),
        p_confirmed=True,
    )


def test_wallet_usage_rejects_wrong_visit_response():
    from test_visit_payment_api import RESULT

    with pytest.raises(RepositoryUnavailableError):
        invoke(RESULT, "wallet")


def test_wallet_lifecycle_rpc_is_scoped_and_validated():
    row = dict(
        id=str(PRODUCT), organization_id=str(ORGANIZATION_ID), customer_id=str(PRODUCT),
        product_id=str(PRODUCT), sale_line_id=str(OP), name_snapshot="회원권",
        money_balance="100", count_balance=1, valid_from="2026-10-01",
        expires_on="2026-12-31", source_snapshot={}, created_at="2026-10-01T00:00:00Z",
        lifecycle_status="paused", paused_on="2026-10-08", lifecycle_version=2,
    )
    result, calls = invoke(row, "wallet-lifecycle")
    assert result.lifecycle_status == "paused"
    assert calls[0].url.path.endswith("/rpc/manage_customer_wallet")
    assert json.loads(calls[0].content) == dict(
        p_organization_id=str(ORGANIZATION_ID), p_customer_id=str(PRODUCT),
        p_wallet_id=str(PRODUCT), p_action="pause", p_extend_days=None,
        p_reason="고객 요청", p_expected_version=1, p_operation_id=str(OP),
    )
    with pytest.raises(RepositoryUnavailableError):
        invoke({**row, "organization_id": str(uuid4())}, "wallet-lifecycle")
