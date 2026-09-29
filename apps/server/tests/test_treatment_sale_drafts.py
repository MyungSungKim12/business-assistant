"""Sale handoff API and user-token PostgREST contract tests (no live database)."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from business_assistant_server.adapters.supabase_treatment_sale_drafts import (
    SupabaseTreatmentSaleDraftRepository,
)
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.treatment_sale_drafts import get_treatment_sale_draft_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_document_api import (
    DOCUMENT_ID,
    ORGANIZATION_ID,
    OWNER_ID,
    FakeAuthAdapter,
    FakeOrganizationRepository,
)

CUSTOMER_ID = UUID("55555555-5555-5555-5555-555555555555")
TREATMENT_ID = UUID("66666666-6666-6666-6666-666666666666")
OPERATION_ID = "77777777-7777-7777-7777-777777777777"
PATH = (
    f"/api/v1/organizations/{ORGANIZATION_ID}/customers/{CUSTOMER_ID}"
    f"/treatments/{TREATMENT_ID}/sale-draft"
)
INBOX = f"/api/v1/organizations/{ORGANIZATION_ID}/treatment-sale-drafts"
FEATURES = ["crm.basic", "finance.basic", "document.template"]
VALUES = {
    "description": "실제 시술",
    "amount": "999999999999.99",
    "consent_document_id": None,
    "exception_reason": "별도 확인",
    "partial_reason": "",
}
PREVIEW = {
    "values": VALUES,
    "line": {
        "description": "실제 시술",
        "quantity": 1,
        "unit_price": VALUES["amount"],
        "line_total": VALUES["amount"],
        "practitioner": "담당",
    },
    "total_amount": VALUES["amount"],
    "source_snapshot": {"treatment": {"version": 2}},
    "consent_status": "not_linked",
    "warnings": ["동의 예외 확인"],
}
DRAFT = {
    "id": str(DOCUMENT_ID),
    "organization_id": str(ORGANIZATION_ID),
    "customer_id": str(CUSTOMER_ID),
    "treatment_id": str(TREATMENT_ID),
    "status": "draft",
    "description": "실제 시술",
    "amount": VALUES["amount"],
    "source_snapshot": PREVIEW["source_snapshot"],
    "created_by": str(OWNER_ID),
    "created_at": "2030-01-01T00:00:00Z",
    "operation_id": OPERATION_ID,
    "request_fingerprint": {"secret": True},
}
CREATE = {"operation_id": OPERATION_ID, "expected_preview": PREVIEW, "confirmed": True}


def request(
    method,
    suffix="",
    *,
    body=None,
    role="owner",
    features=None,
    token="owner-token",
    calls=None,
    provider_body=None,
    provider_status=200,
    path=PATH,
):
    def provider(req):
        if calls is not None:
            calls.append(req)
        if provider_status != 200 or provider_body is not None:
            return httpx.Response(provider_status, json=provider_body)
        if req.url.path.endswith("/preview_treatment_sale_draft"):
            return httpx.Response(200, json=PREVIEW)
        if req.url.path.endswith("/treatment_records"):
            return httpx.Response(200, json=[{"id": str(TREATMENT_ID)}])
        if int(req.url.params.get("offset", "0")) > 0:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[DRAFT])

    async def send():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            FEATURES if features is None else features, role
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as backend:
            repo = SupabaseTreatmentSaleDraftRepository(
                "https://example.supabase.co", "public", "user-token", backend
            )
            app.dependency_overrides[get_treatment_sale_draft_repository] = lambda: repo
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.request(
                    method,
                    path + suffix,
                    json=body,
                    headers={} if token is None else {"Authorization": f"Bearer {token}"},
                )

    return asyncio.run(send())


@pytest.mark.parametrize(
    "method,suffix,body,path",
    [
        ("GET", "", None, PATH),
        ("GET", "", None, INBOX),
        ("POST", "/preview", {"values": VALUES}, PATH),
        ("POST", "", CREATE, PATH),
    ],
)
def test_every_route_requires_all_features_membership_and_auth(method, suffix, body, path):
    options = [({"token": None}, 401), ({"token": "outsider-token"}, 403), ({"role": None}, 403)]
    options += [({"features": [f for f in FEATURES if f != missing]}, 403) for missing in FEATURES]
    for kwargs, expected in options:
        calls = []
        assert (
            request(method, suffix, body=body, path=path, calls=calls, **kwargs).status_code
            == expected
        )
        assert calls == []


def test_member_read_preview_but_manager_create_only():
    assert request("GET", role="member").status_code == 200
    assert request("GET", role="member", path=INBOX).status_code == 200
    assert request("POST", "/preview", body={"values": VALUES}, role="member").json() == PREVIEW
    calls = []
    assert request("POST", body=CREATE, role="member", calls=calls).status_code == 403
    assert not calls


@pytest.mark.parametrize("role", ["owner", "admin"])
def test_create_forwards_exact_review_and_retry_identity_and_strips_private(role):
    calls = []
    response = request("POST", body=CREATE, calls=calls, role=role)
    assert response.status_code == 201
    assert response.json()["amount"] == "999999999999.99"
    assert "operation_id" not in response.json()
    assert "request_fingerprint" not in response.json()
    assert json.loads(calls[0].content) == {
        "p_organization_id": str(ORGANIZATION_ID),
        "p_customer_id": str(CUSTOMER_ID),
        "p_treatment_id": str(TREATMENT_ID),
        "p_operation_id": OPERATION_ID,
        "p_expected_preview": PREVIEW,
        "p_confirmed": True,
    }
    assert calls[0].headers["authorization"] == "Bearer user-token"


@pytest.mark.parametrize("amount", [None, 0, 1.2, True, "-1", "1e2", "1.001", "1000000000000", ""])
def test_invalid_amount_never_reaches_database(amount):
    calls = []
    response = request(
        "POST", "/preview", body={"values": {**VALUES, "amount": amount}}, calls=calls
    )
    assert response.status_code == 422
    assert not calls


@pytest.mark.parametrize(
    "patch",
    [
        {"description": ""},
        {"description": " "},
        {"description": "x" * 201},
        {"exception_reason": "x" * 2001},
        {"partial_reason": None},
        {"consent_document_id": "bad"},
        {"injected": True},
    ],
)
def test_values_constraints(patch):
    assert request("POST", "/preview", body={"values": {**VALUES, **patch}}).status_code == 422


@pytest.mark.parametrize("confirmed", [False, 1, "true", None])
def test_confirmation_must_be_literal_true(confirmed):
    calls = []
    assert request("POST", body={**CREATE, "confirmed": confirmed}, calls=calls).status_code == 422
    assert not calls


def test_parent_scope_and_pending_inbox_filters():
    calls = []
    assert request("GET", calls=calls).status_code == 200
    assert calls[0].url.path.endswith("/treatment_records")
    assert dict(calls[0].url.params)["customer_id"] == f"eq.{CUSTOMER_ID}"
    query = dict(calls[-1].url.params)
    assert query["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert query["customer_id"] == f"eq.{CUSTOMER_ID}"
    assert query["treatment_id"] == f"eq.{TREATMENT_ID}"
    assert request("GET", provider_body=[]).status_code == 404
    calls.clear()
    assert request("GET", path=INBOX, calls=calls).status_code == 200
    assert dict(calls[0].url.params)["status"] == "eq.draft"
    assert dict(calls[0].url.params)["order"] == "created_at.desc,id.desc"


@pytest.mark.parametrize(
    "code,status",
    [("P0001", 409), ("P0002", 404), ("42501", 403), ("22023", 422), ("unknown", 503)],
)
def test_database_errors_are_sanitized(code, status):
    response = request(
        "POST",
        body=CREATE,
        provider_status=400,
        provider_body={"code": code, "message": "private data"},
    )
    assert response.status_code == status
    assert "private data" not in response.text


def test_numeric_postgrest_amount_is_parsed_without_float_round_trip():
    async def send():
        def provider(req):
            raw = json.dumps([DRAFT]).replace('"999999999999.99"', "999999999999.99")
            return httpx.Response(200, content=raw, headers={"content-type": "application/json"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            repo = SupabaseTreatmentSaleDraftRepository(
                "https://example.supabase.co", "p", "t", client
            )
            return await repo.create(
                ORGANIZATION_ID, CUSTOMER_ID, TREATMENT_ID, UUID(OPERATION_ID), PREVIEW, True
            )

    assert asyncio.run(send()).model_dump(mode="json")["amount"] == "999999999999.99"
