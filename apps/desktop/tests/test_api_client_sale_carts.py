import json
from uuid import uuid4

import httpx
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_visit_sale_cart_paths_auth_and_payloads() -> None:
    org, customer, visit, draft, line, operation = (uuid4() for _ in range(6))
    session = Session("token", None, uuid4())
    calls = []
    bundle = {"visit": {"id": str(visit)}, "cart": {"version": 2}, "lines": []}

    def handle(request):
        calls.append(request)
        return httpx.Response(
            200,
            json=[bundle["visit"]]
            if request.method == "GET" and request.url.path.endswith("/visits")
            else bundle,
        )

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(handle)))
    assert api.list_customer_visits(org, session, customer, "open") == [bundle["visit"]]
    assert api.create_customer_visit(org, session, customer, operation) == bundle
    assert api.get_sale_cart(org, session, visit) == bundle
    assert api.add_treatment_draft_to_cart(org, session, visit, draft, 2, operation) == bundle
    values = {"quantity": 2, "unit_price": "100.25", "staff_name": "담당"}
    assert api.update_sale_cart_line(org, session, visit, line, 3, operation, values) == bundle
    assert api.remove_sale_cart_line(org, session, visit, line, 4, operation, "고객 요청") == bundle
    assert api.restore_sale_cart_line(org, session, visit, line, 5, operation) == bundle
    assert api.review_sale_cart(org, session, visit, 6, operation, True) == bundle
    assert api.cancel_customer_visit(org, session, visit, 1, operation) == bundle

    base = f"/api/v1/organizations/{org}"
    assert [call.url.path for call in calls] == [
        f"{base}/visits",
        f"{base}/customers/{customer}/visits",
        f"{base}/visits/{visit}/sale-cart",
        f"{base}/visits/{visit}/sale-cart/lines/treatment-draft",
        f"{base}/visits/{visit}/sale-cart/lines/{line}",
        f"{base}/visits/{visit}/sale-cart/lines/{line}/remove",
        f"{base}/visits/{visit}/sale-cart/lines/{line}/restore",
        f"{base}/visits/{visit}/sale-cart/review",
        f"{base}/visits/{visit}/cancel",
    ]
    assert dict(calls[0].url.params) == {"customer_id": str(customer), "status": "open"}
    assert json.loads(calls[1].content) == {"operation_id": str(operation)}
    assert json.loads(calls[3].content) == {
        "draft_id": str(draft),
        "expected_version": 2,
        "operation_id": str(operation),
    }
    assert json.loads(calls[4].content) == {
        **values,
        "expected_version": 3,
        "operation_id": str(operation),
    }
    assert json.loads(calls[5].content)["reason"] == "고객 요청"
    assert all(call.headers["Authorization"] == "Bearer token" for call in calls)


def test_payment_paths_preserve_exact_payload_and_cart_draft_endpoint():
    org, visit = uuid4(), uuid4()
    session = Session("token", None, uuid4())
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(
            200, json=[] if request.url.path.endswith("sale-cart-drafts") else {"paid_amount": "3"}
        )

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(handle)))
    payload = {
        "operation_id": str(uuid4()),
        "expected_version": 4,
        "confirmed": True,
        "payments": [{"method": "cash", "amount": "3", "reference": ""}],
    }
    api.list_sale_cart_drafts(org, session)
    api.get_visit_payments(org, session, visit)
    api.record_visit_payment(org, session, visit, payload)
    assert calls[0].url.path == f"/api/v1/organizations/{org}/sale-cart-drafts"
    assert (
        calls[1].url.path
        == calls[2].url.path
        == f"/api/v1/organizations/{org}/visits/{visit}/payments"
    )
    assert json.loads(calls[2].content) == payload
    assert all(call.headers["Authorization"] == "Bearer token" for call in calls)
