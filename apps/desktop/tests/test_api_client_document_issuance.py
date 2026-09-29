import json
from uuid import uuid4

import httpx
import pytest
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_document_issuance_contract_uses_tenant_customer_treatment_and_auth():
    org, customer, treatment, template = uuid4(), uuid4(), uuid4(), uuid4()
    session = Session("token", None, uuid4())
    calls = []
    result = {"title": "서식", "content": "검토본", "missing_fields": []}

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=[result] if request.method == "GET" else result)

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(handle)))
    assert api.preview_treatment_document(org, session, customer, treatment, template) == result
    payload = {
        "template_id": str(template),
        "operation_id": str(uuid4()),
        "expected_preview": result,
    }
    assert api.issue_treatment_document(org, session, customer, treatment, payload) == result
    assert api.list_issued_treatment_documents(org, session, customer, treatment) == [result]
    path = f"/api/v1/organizations/{org}/customers/{customer}/treatments/{treatment}/documents"
    assert [request.url.path for request in calls] == [path + "/preview", path, path]
    assert json.loads(calls[1].content) == payload
    assert all(request.headers["Authorization"] == "Bearer token" for request in calls)


def test_failed_issue_surfaces_status_for_retry():
    api = ApiClient(
        "https://test",
        httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(409))),
    )
    with pytest.raises(httpx.HTTPStatusError) as caught:
        api.issue_treatment_document(uuid4(), Session("token", None, uuid4()), uuid4(), uuid4(), {})
    assert caught.value.response.status_code == 409


def test_consent_requests_include_document_scope_and_preserve_retry_payload():
    org, customer, treatment, document = uuid4(), uuid4(), uuid4(), uuid4()
    session = Session("token", None, uuid4())
    calls = []

    def provider(request):
        calls.append(request)
        return httpx.Response(200, json=[] if request.method == "GET" else {"revision": 1})

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(provider)))
    assert api.list_document_consent_events(org, session, customer, treatment, document) == []
    payload = {
        "operation_id": str(uuid4()),
        "expected_revision": 0,
        "action": "sign",
        "values": {"signer_name": "고객", "strokes": [[[0, 0], [1, 1]]], "confirmed": True},
    }
    api.record_document_consent_event(org, session, customer, treatment, document, payload)
    assert json.loads(calls[-1].content) == payload
    assert calls[-1].url.path.endswith(f"/{treatment}/documents/{document}/events")
    assert all(call.headers["Authorization"] == "Bearer token" for call in calls)
