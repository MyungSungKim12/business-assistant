import json
from datetime import date
from uuid import uuid4

import httpx
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_daily_settlement_http_paths_auth_and_payloads():
    organization_id, operation_id = uuid4(), uuid4()
    session = Session("access", None, uuid4())
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"is_closed": False})

    client = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(handle)))
    day = date(2026, 10, 8)
    client.get_sale_daily_settlement(organization_id, session, day)
    close_payload = {
        "operation_id": str(operation_id),
        "counted_cash": "100",
        "reason": "마감",
        "confirmed": True,
    }
    client.close_sale_day(organization_id, session, day, close_payload)
    adjust_payload = {**close_payload, "expected_version": 2}
    client.adjust_sale_day_close(organization_id, session, day, adjust_payload)

    root = f"/api/v1/organizations/{organization_id}/sale-daily-settlement"
    assert [call.url.path for call in calls] == [root, f"{root}/close", f"{root}/adjustments"]
    assert all(dict(call.url.params) == {"business_date": "2026-10-08"} for call in calls)
    assert json.loads(calls[1].content) == close_payload
    assert json.loads(calls[2].content)["expected_version"] == 2
    assert all(call.headers["authorization"] == "Bearer access" for call in calls)
