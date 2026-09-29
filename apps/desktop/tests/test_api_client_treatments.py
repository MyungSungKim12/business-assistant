import json
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session

ORG, CUSTOMER, RECORD = uuid4(), uuid4(), uuid4()
SESSION = Session("token", None, uuid4())
ROW = dict(
    id=str(RECORD),
    customer_id=str(CUSTOMER),
    treatment_date="2026-09-18",
    treatment_name="수분 관리",
    category="피부",
    practitioner="김담당",
    notes="기록",
    amount="15000.50",
    next_visit_date=None,
)


def test_treatment_requests_are_authenticated_and_preserve_amount():
    calls = []

    def respond(req):
        calls.append(req)
        return httpx.Response(200, json=[ROW] if req.method == "GET" else ROW)

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    assert api.list_treatments(ORG, SESSION, CUSTOMER)[0].amount == Decimal("15000.50")
    values = {k: v for k, v in ROW.items() if k not in ("id", "customer_id")}
    assert api.create_treatment(ORG, SESSION, CUSTOMER, values).id == RECORD
    assert api.update_treatment(ORG, SESSION, CUSTOMER, RECORD, values).id == RECORD
    assert [c.method for c in calls] == ["GET", "POST", "PATCH"]
    assert (
        calls[-1].url.path
        == f"/api/v1/organizations/{ORG}/customers/{CUSTOMER}/treatments/{RECORD}"
    )
    assert all(c.headers["Authorization"] == "Bearer token" for c in calls)
    assert json.loads(calls[1].content)["amount"] == "15000.50"


@pytest.mark.parametrize("payload", [{}, [dict(ROW, amount="NaN")], [dict(ROW, id="bad")]])
def test_invalid_treatment_responses_are_rejected(payload):
    api = ApiClient(
        "https://api.test",
        httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))),
    )
    with pytest.raises(ValueError):
        api.list_treatments(ORG, SESSION, CUSTOMER)


def test_update_failure_not_swallowed():
    api = ApiClient(
        "https://api.test",
        httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404))),
    )
    with pytest.raises(httpx.HTTPStatusError):
        api.update_treatment(ORG, SESSION, CUSTOMER, RECORD, {})


def test_lifecycle_http_contract_and_strict_version():
    calls = []

    def respond(req):
        calls.append(req)
        return httpx.Response(
            200,
            json=[]
            if req.method == "GET"
            else dict(ROW, status="in_progress", version=2, started_at="2026-09-18T02:00:00Z"),
        )

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    payload = {
        "action": "start",
        "expected_version": 1,
        "operation_id": str(uuid4()),
        "values": None,
        "reason": "",
    }
    result = api.mutate_treatment(ORG, SESSION, CUSTOMER, RECORD, payload)
    assert result.status == "in_progress" and result.version == 2
    assert api.list_treatment_events(ORG, SESSION, CUSTOMER, RECORD) == []
    assert calls[0].url.path.endswith(f"/{RECORD}/mutations")
    assert calls[1].url.path.endswith(f"/{RECORD}/events")
    assert json.loads(calls[0].content) == payload
    assert all(c.headers["Authorization"] == "Bearer token" for c in calls)
    bad = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json=[dict(ROW, version=True)])
            )
        ),
    )
    with pytest.raises(ValueError):
        bad.list_treatments(ORG, SESSION, CUSTOMER)
