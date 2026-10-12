import json
from uuid import uuid4

import httpx
import pytest
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_catalog_client_preserves_auth_scope_and_operation():
    org, product, visit, customer, operation = (uuid4() for _ in range(5))
    session = Session("token", None, uuid4())
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json=[] if request.method == "GET" else {"id": str(product)})

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(serve)))
    values = {"name": "크림", "operation_id": str(operation)}
    assert api.list_catalog_products(org, session) == []
    api.save_catalog_product(org, session, None, values)
    api.save_catalog_product(org, session, product, {**values, "expected_version": 2})
    api.receive_catalog_stock(
        org, session, product, {"quantity": 3, "reason": "입고", "operation_id": str(operation)}
    )
    api.change_catalog_stock(
        org,
        session,
        product,
        {
            "kind": "disposal",
            "quantity": 1,
            "reason": "파손",
            "expected_version": 4,
            "operation_id": str(operation),
        },
    )
    api.add_catalog_product_to_cart(org, session, visit, product, 5, operation)
    assert api.list_customer_wallets(org, session, customer) == []
    api.manage_customer_wallet(
        org, session, customer, product,
        {"action": "pause", "reason": "고객 요청", "expected_version": 1,
         "operation_id": str(operation)},
    )
    api.use_customer_wallet(
        org,
        session,
        visit,
        {
            "wallet_id": str(product),
            "sale_line_id": str(uuid4()),
            "mode": "money",
            "amount": "1000",
            "expected_cart_version": 5,
            "operation_id": str(operation),
            "confirmed": True,
        },
    )
    assert api.list_catalog_stock_ledger(org, session, product) == []
    base = f"/api/v1/organizations/{org}"
    assert [call.url.path for call in calls] == [
        f"{base}/catalog-products",
        f"{base}/catalog-products",
        f"{base}/catalog-products/{product}",
        f"{base}/catalog-products/{product}/stock-receipts",
        f"{base}/catalog-products/{product}/stock-adjustments",
        f"{base}/visits/{visit}/sale-cart/lines/catalog-product",
        f"{base}/customers/{customer}/wallets",
        f"{base}/customers/{customer}/wallets/{product}/lifecycle",
        f"{base}/visits/{visit}/wallet-usages",
        f"{base}/catalog-products/{product}/stock-ledger",
    ]
    assert [call.method for call in calls] == [
        "GET",
        "POST",
        "PUT",
        "POST",
        "POST",
        "POST",
        "GET",
        "POST",
        "POST",
        "GET",
    ]
    assert json.loads(calls[1].content) == values
    assert json.loads(calls[5].content) == {
        "product_id": str(product),
        "expected_version": 5,
        "operation_id": str(operation),
    }
    assert all(call.headers["Authorization"] == "Bearer token" for call in calls)


def test_catalog_list_rejects_malformed_success():
    api = ApiClient(
        "https://test",
        httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))),
    )
    with pytest.raises(ValueError):
        api.list_catalog_products(uuid4(), Session("token", None, uuid4()))
