"""Consent API authorization, payload validation and PostgREST boundaries."""

import asyncio
import json

import httpx
import pytest
from business_assistant_server.adapters.supabase_document_consent import (
    SupabaseDocumentConsentRepository,
)
from business_assistant_server.api.document_consent import get_document_consent_repository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_document_api import (
    DOCUMENT_ID,
    ORGANIZATION_ID,
    OWNER_ID,
    FakeAuthAdapter,
    FakeOrganizationRepository,
)
from test_treatment_documents import CUSTOMER_ID, OPERATION_ID, TREATMENT_ID

PATH = (
    f"/api/v1/organizations/{ORGANIZATION_ID}/customers/{CUSTOMER_ID}"
    f"/treatments/{TREATMENT_ID}/documents/{DOCUMENT_ID}/events"
)
SIGN = {"signer_name": "Customer A", "strokes": [[[0, 0], [1, 1]]], "confirmed": True}
DELIVER = {
    "method": "paper",
    "recipient": "Customer A",
    "reference": "",
    "note": "",
    "confirmed": True,
}
REVOKE = {"reason": "Withdraw consent", "confirmed": True}
BODY = {"expected_revision": 0, "operation_id": OPERATION_ID, "action": "sign", "values": SIGN}
EVENT = {
    "id": OPERATION_ID,
    "organization_id": str(ORGANIZATION_ID),
    "document_id": str(DOCUMENT_ID),
    "revision": 1,
    "action": "sign",
    "values": SIGN,
    "actor_id": str(OWNER_ID),
    "occurred_at": "2030-01-01T00:00:00Z",
    "content_hash": "a" * 64,
    "operation_id": OPERATION_ID,
    "request_fingerprint": "private",
}


def request(
    method: str,
    *,
    body: object = None,
    role: str | None = "owner",
    features: list[str] | None = None,
    token: str | None = "owner-token",
    provider_status: int = 200,
    provider_body: object = None,
    parent_body: object = None,
    requests: list[httpx.Request] | None = None,
    path: str = PATH,
) -> httpx.Response:
    def provider(req: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(req)
        if provider_status != 200:
            return httpx.Response(provider_status, json=provider_body)
        if req.url.path.endswith("/issued_treatment_documents"):
            return httpx.Response(
                200, json=[{"id": str(DOCUMENT_ID)}] if parent_body is None else parent_body
            )
        return httpx.Response(200, json=[EVENT] if provider_body is None else provider_body)

    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["crm.basic", "document.template"] if features is None else features, role
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as provider_client:
            repository = SupabaseDocumentConsentRepository(
                "https://example.supabase.co", "publishable", "user-token", provider_client
            )
            app.dependency_overrides[get_document_consent_repository] = lambda: repository
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://testserver"
            ) as client:
                return await client.request(
                    method,
                    path,
                    json=body,
                    headers={} if token is None else {"Authorization": f"Bearer {token}"},
                )

    return asyncio.run(send())


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_requires_auth_membership_and_both_features(method) -> None:
    for options, expected in [
        ({"token": None}, 401),
        ({"token": "outsider-token"}, 403),
        ({"role": None}, 403),
        ({"features": ["crm.basic"]}, 403),
        ({"features": ["document.template"]}, 403),
    ]:
        calls = []
        assert request(method, body=BODY, requests=calls, **options).status_code == expected
        assert calls == []


def test_member_reads_evidence_but_cannot_record() -> None:
    assert request("GET", role="member").json()[0]["values"] == SIGN
    calls = []
    assert request("POST", body=BODY, role="member", requests=calls).status_code == 403
    assert calls == []


@pytest.mark.parametrize("role", ["owner", "admin"])
@pytest.mark.parametrize(
    "action,values", [("sign", SIGN), ("deliver", DELIVER), ("revoke", REVOKE)]
)
def test_record_exact_rpc_payload_and_hide_retry_metadata(role, action, values) -> None:
    calls = []
    body = {**BODY, "action": action, "values": values}
    response = request("POST", body=body, role=role, requests=calls)
    assert response.status_code == 201
    assert "operation_id" not in response.json()
    assert "request_fingerprint" not in response.json()
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/rpc/record_treatment_document_event")
    assert json.loads(calls[0].content) == {
        "p_organization_id": str(ORGANIZATION_ID),
        "p_customer_id": str(CUSTOMER_ID),
        "p_treatment_id": str(TREATMENT_ID),
        "p_document_id": str(DOCUMENT_ID),
        "p_expected_revision": 0,
        "p_operation_id": OPERATION_ID,
        "p_action": action,
        "p_values": values,
    }
    assert calls[0].headers["authorization"] == "Bearer user-token"


def test_history_checks_exact_parent_and_scopes_events_in_revision_order() -> None:
    calls = []
    response = request("GET", requests=calls)
    assert response.status_code == 200
    assert "operation_id" not in response.json()[0]
    assert "request_fingerprint" not in response.json()[0]
    assert dict(calls[0].url.params) == {
        "organization_id": f"eq.{ORGANIZATION_ID}",
        "customer_id": f"eq.{CUSTOMER_ID}",
        "treatment_id": f"eq.{TREATMENT_ID}",
        "id": f"eq.{DOCUMENT_ID}",
        "select": "id",
    }
    assert calls[1].url.path.endswith("/treatment_document_events")
    assert dict(calls[1].url.params) == {
        "organization_id": f"eq.{ORGANIZATION_ID}",
        "document_id": f"eq.{DOCUMENT_ID}",
        "order": "revision.asc",
        "limit": "250",
        "offset": "0",
    }
    assert request("GET", provider_body=[]).json() == []


def test_history_reads_multiple_pages_including_terminal_withdrawal() -> None:
    async def run() -> None:
        offsets = []

        def provider(req: httpx.Request) -> httpx.Response:
            if req.url.path.endswith("/issued_treatment_documents"):
                return httpx.Response(200, json=[{"id": str(DOCUMENT_ID)}])
            offset = int(req.url.params["offset"])
            offsets.append(offset)
            rows = [
                dict(EVENT, revision=i + 1, action="sign" if i == 0 else "deliver")
                for i in range(offset, min(offset + 250, 251))
            ]
            if offset == 250:
                rows[-1] = dict(rows[-1], action="revoke", values=REVOKE)
            return httpx.Response(200, json=rows)

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseDocumentConsentRepository("https://test", "key", "token", client)
            rows = await repo.list_events(ORGANIZATION_ID, CUSTOMER_ID, TREATMENT_ID, DOCUMENT_ID)
        assert len(rows) == 251
        assert rows[-1].action == "revoke"
        assert offsets == [0, 250]

    asyncio.run(run())


def test_missing_parent_stops_history_query() -> None:
    calls = []
    assert request("GET", parent_body=[], requests=calls).status_code == 404
    assert len(calls) == 1
    calls.clear()
    other = PATH.replace(str(ORGANIZATION_ID), "88888888-8888-8888-8888-888888888888")
    assert request("GET", path=other, requests=calls).status_code == 404
    assert calls == []


@pytest.mark.parametrize(
    "changes",
    [
        {"expected_revision": -1},
        {"expected_revision": True},
        {"expected_revision": "0"},
        {"expected_revision": 0.5},
        {"expected_revision": 2147483648},
        {"operation_id": "bad"},
        {"action": "SIGN"},
        {"action": "unknown"},
        {"values": {}},
        {"values": None},
        {"values": []},
        {"extra": "forged"},
    ],
)
def test_rejects_invalid_envelope_before_rpc(changes) -> None:
    calls = []
    assert request("POST", body={**BODY, **changes}, requests=calls).status_code == 422
    assert calls == []


@pytest.mark.parametrize("key", ["expected_revision", "operation_id", "action", "values"])
def test_requires_complete_envelope(key) -> None:
    calls = []
    body = {name: value for name, value in BODY.items() if name != key}
    assert request("POST", body=body, requests=calls).status_code == 422
    assert calls == []


@pytest.mark.parametrize(
    "action,values", [("sign", SIGN), ("deliver", DELIVER), ("revoke", REVOKE)]
)
def test_requires_all_action_value_fields(action, values) -> None:
    for omitted in values:
        calls = []
        incomplete = {key: value for key, value in values.items() if key != omitted}
        body = {**BODY, "action": action, "values": incomplete}
        assert request("POST", body=body, requests=calls).status_code == 422
        assert calls == []


def test_accepts_maximum_drawing_and_preserves_identical_retry_request() -> None:
    calls = []
    values = {**SIGN, "strokes": [[[0, 0], [1, 1]] * 250] * 10}
    body = {**BODY, "values": values}
    first = request("POST", body=body, requests=calls)
    retry = request("POST", body=body, requests=calls)
    assert first.status_code == retry.status_code == 201
    assert first.json() == retry.json()
    assert calls[0].content == calls[1].content
    assert json.loads(calls[0].content)["p_values"] == values


@pytest.mark.parametrize(
    "values",
    [
        {**SIGN, "signer_name": " "},
        {**SIGN, "signer_name": "x" * 101},
        {**SIGN, "confirmed": False},
        {**SIGN, "confirmed": 1},
        {**SIGN, "confirmed": "true"},
        {**SIGN, "extra": "forged"},
        {**SIGN, "strokes": []},
        {**SIGN, "strokes": [[]]},
        {**SIGN, "strokes": [[[0, 0]]]},
        {**SIGN, "strokes": [[[0, 0], [0, 0]]]},
        {**SIGN, "strokes": [[[False, 0], [1, 1]]]},
        {**SIGN, "strokes": [[["0", 0], [1, 1]]]},
        {**SIGN, "strokes": [[[0, -0.1], [1, 1]]]},
        {**SIGN, "strokes": [[[0, 0], [1.1, 1]]]},
        {**SIGN, "strokes": [[[0, 0, 0], [1, 1]]]},
        {**SIGN, "strokes": [[[0, 0], [1, 1]]] * 51},
        {**SIGN, "strokes": [[[0, 0], [1, 1]] * 251]},
        {**SIGN, "strokes": [[[0, 0], [1, 1]] * 250] * 11},
    ],
)
def test_rejects_invalid_signatures_before_rpc(values) -> None:
    calls = []
    assert request("POST", body={**BODY, "values": values}, requests=calls).status_code == 422
    assert calls == []


@pytest.mark.parametrize(
    "action,values",
    [
        ("deliver", {**DELIVER, "method": "fax"}),
        ("deliver", {**DELIVER, "recipient": " "}),
        ("deliver", {**DELIVER, "recipient": "x" * 201}),
        ("deliver", {**DELIVER, "reference": "x" * 501}),
        ("deliver", {**DELIVER, "note": "x" * 2001}),
        ("deliver", {**DELIVER, "confirmed": 1}),
        ("deliver", {**DELIVER, "reference": None}),
        ("deliver", SIGN),
        ("revoke", {**REVOKE, "reason": " "}),
        ("revoke", {**REVOKE, "reason": "x" * 2001}),
        ("revoke", {**REVOKE, "confirmed": 1}),
        ("revoke", {**REVOKE, "extra": "forged"}),
    ],
)
def test_rejects_invalid_delivery_and_revocation_before_rpc(action, values) -> None:
    calls = []
    body = {**BODY, "action": action, "values": values}
    assert request("POST", body=body, requests=calls).status_code == 422
    assert calls == []


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize(
    "code,status",
    [
        ("P0001", 409),
        ("P0002", 404),
        ("42501", 403),
        ("22023", 422),
        ("XX000", 503),
    ],
)
def test_safe_provider_errors(method, code, status) -> None:
    response = request(
        method,
        body=BODY,
        provider_status=400,
        provider_body={"code": code, "message": "private patient data"},
    )
    assert response.status_code == status
    assert "private" not in response.text


@pytest.mark.parametrize("payload", [{}, [], [EVENT, EVENT], [{"id": "bad"}]])
def test_record_requires_exactly_one_valid_event(payload) -> None:
    assert request("POST", body=BODY, provider_body=payload).status_code == 503


@pytest.mark.parametrize("payload", [{}, [{"id": "bad"}], [None]])
def test_malformed_history_is_safe_unavailability(payload) -> None:
    assert request("GET", provider_body=payload).status_code == 503


@pytest.mark.parametrize("payload", [{}, [None], [{"id": "bad"}], [{"id": str(DOCUMENT_ID)}] * 2])
def test_malformed_parent_is_safe_unavailability(payload) -> None:
    assert request("GET", parent_body=payload).status_code == 503
