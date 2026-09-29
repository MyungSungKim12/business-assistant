import json
from uuid import uuid4

import httpx
import pytest
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_sale_draft_contract_scope_auth_and_exact_payload():
    org, customer, treatment = uuid4(), uuid4(), uuid4()
    session = Session("token", None, uuid4())
    calls = []
    row = {"amount": "12345.67", "status": "draft"}

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=[row] if request.method == "GET" else row)

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(handle)))
    values = {"amount": "12345.67", "description": "시술"}
    payload = {
        "operation_id": str(uuid4()),
        "expected_preview": {"values": values},
        "confirmed": True,
    }
    api.preview_treatment_sale_draft(org, session, customer, treatment, values)
    assert api.create_treatment_sale_draft(org, session, customer, treatment, payload) == row
    assert api.list_treatment_sale_drafts(org, session, customer, treatment) == [row]
    assert api.list_treatment_sale_drafts(org, session) == [row]
    scoped = f"/api/v1/organizations/{org}/customers/{customer}/treatments/{treatment}/sale-draft"
    assert [r.url.path for r in calls] == [
        scoped + "/preview",
        scoped,
        scoped,
        f"/api/v1/organizations/{org}/treatment-sale-drafts",
    ]
    assert json.loads(calls[0].content) == {"values": values}
    assert json.loads(calls[1].content) == payload
    assert all(r.headers["Authorization"] == "Bearer token" for r in calls)
    with pytest.raises(ValueError):
        api.list_treatment_sale_drafts(org, session, customer)
    assert len(calls) == 4
