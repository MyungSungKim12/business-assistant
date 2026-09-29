"""API authorization and actual PostgREST boundary contracts for issued documents."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from business_assistant_server.adapters.supabase_treatment_documents import (
    SupabaseTreatmentDocumentRepository,
)
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.treatment_documents import get_treatment_document_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_document_api import (
    DOCUMENT_ID,
    ORGANIZATION_ID,
    OWNER_ID,
    TEMPLATE_ID,
    FakeAuthAdapter,
    FakeOrganizationRepository,
)

CUSTOMER_ID = UUID("55555555-5555-5555-5555-555555555555")
TREATMENT_ID = UUID("66666666-6666-6666-6666-666666666666")
OPERATION_ID = "77777777-7777-7777-7777-777777777777"
PATH = (
    f"/api/v1/organizations/{ORGANIZATION_ID}/customers/{CUSTOMER_ID}"
    f"/treatments/{TREATMENT_ID}/documents"
)
PREVIEW = {
    "template_id": str(TEMPLATE_ID),
    "template_version": 1,
    "title": "Consent",
    "content": "Customer A",
    "source_snapshot": {"customer": {"name": "Customer A"}},
    "missing_fields": [],
}
ISSUED = {
    "id": str(DOCUMENT_ID),
    "organization_id": str(ORGANIZATION_ID),
    "customer_id": str(CUSTOMER_ID),
    "treatment_id": str(TREATMENT_ID),
    "template_id": str(TEMPLATE_ID),
    "template_version": 1,
    "title": "Consent",
    "content": "Customer A",
    "source_snapshot": PREVIEW["source_snapshot"],
    "issued_by": str(OWNER_ID),
    "issued_at": "2030-01-01T00:00:00Z",
    "operation_id": OPERATION_ID,
    "request_fingerprint": {"private": True},
}
ISSUE_BODY = {
    "template_id": str(TEMPLATE_ID),
    "operation_id": OPERATION_ID,
    "expected_preview": PREVIEW,
}


def request(
    method: str,
    suffix: str = "",
    *,
    body: object = None,
    role: str | None = "owner",
    features: list[str] | None = None,
    token: str | None = "owner-token",
    provider_status: int = 200,
    provider_body: object = None,
    requests: list[httpx.Request] | None = None,
    path: str = PATH,
) -> httpx.Response:
    def provider(req: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(req)
        if provider_status != 200 or provider_body is not None:
            return httpx.Response(provider_status, json=provider_body)
        if req.url.path.endswith("/preview_treatment_document"):
            return httpx.Response(200, json=PREVIEW)
        if req.url.path.endswith("/treatment_records"):
            return httpx.Response(200, json=[{"id": str(TREATMENT_ID)}])
        return httpx.Response(200, json=[ISSUED])

    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["crm.basic", "document.template"] if features is None else features, role
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as provider_client:
            repository = SupabaseTreatmentDocumentRepository(
                "https://example.supabase.co", "publishable", "user-token", provider_client
            )
            app.dependency_overrides[get_treatment_document_repository] = lambda: repository
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://testserver"
            ) as client:
                return await client.request(
                    method,
                    path + suffix,
                    json=body,
                    headers={} if token is None else {"Authorization": f"Bearer {token}"},
                )

    return asyncio.run(send())


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("GET", "", None),
        ("POST", "/preview", {"template_id": str(TEMPLATE_ID)}),
        ("POST", "", ISSUE_BODY),
    ],
)
def test_all_routes_require_auth_membership_and_both_features(method, suffix, body) -> None:
    for options, expected in [
        ({"token": None}, 401),
        ({"token": "outsider-token"}, 403),
        ({"role": None}, 403),
        ({"features": ["crm.basic"]}, 403),
        ({"features": ["document.template"]}, 403),
    ]:
        calls: list[httpx.Request] = []
        response = request(method, suffix, body=body, requests=calls, **options)
        assert response.status_code == expected
        assert calls == []


def test_member_can_preview_and_read_but_cannot_issue() -> None:
    assert request("GET", role="member").status_code == 200
    response = request("POST", "/preview", body={"template_id": str(TEMPLATE_ID)}, role="member")
    assert response.json() == PREVIEW
    calls: list[httpx.Request] = []
    assert request("POST", body=ISSUE_BODY, role="member", requests=calls).status_code == 403
    assert calls == []


@pytest.mark.parametrize("role", ["owner", "admin"])
def test_issue_preserves_review_and_operation_and_hides_internal_fields(role: str) -> None:
    calls: list[httpx.Request] = []
    response = request("POST", body=ISSUE_BODY, role=role, requests=calls)
    assert response.status_code == 201
    assert "request_fingerprint" not in response.json()
    assert "operation_id" not in response.json()
    assert response.json()["content"] == "Customer A"
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/rpc/issue_treatment_document")
    assert json.loads(calls[0].content) == {
        "p_organization_id": str(ORGANIZATION_ID),
        "p_customer_id": str(CUSTOMER_ID),
        "p_treatment_id": str(TREATMENT_ID),
        "p_template_id": str(TEMPLATE_ID),
        "p_operation_id": OPERATION_ID,
        "p_expected_preview": PREVIEW,
    }
    assert calls[0].headers["authorization"] == "Bearer user-token"


def test_history_filters_all_ids_orders_and_strips_internal_fields() -> None:
    calls: list[httpx.Request] = []
    response = request("GET", requests=calls)
    assert response.status_code == 200
    assert "operation_id" not in response.json()[0]
    assert "request_fingerprint" not in response.json()[0]
    query = dict(calls[-1].url.params)
    assert query["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert query["customer_id"] == f"eq.{CUSTOMER_ID}"
    assert query["treatment_id"] == f"eq.{TREATMENT_ID}"
    assert query["order"] == "issued_at.desc,id.desc"
    assert calls[-1].url.path.endswith("/issued_treatment_documents")


def test_wrong_parent_or_missing_treatment_is_not_empty_history() -> None:
    assert request("GET", provider_body=[]).status_code == 404
    other = PATH.replace(str(ORGANIZATION_ID), "88888888-8888-8888-8888-888888888888")
    calls: list[httpx.Request] = []
    assert request("GET", path=other, requests=calls).status_code in {403, 404}
    assert calls == []


@pytest.mark.parametrize(
    "body",
    [
        {"template_id": str(TEMPLATE_ID)},
        {**ISSUE_BODY, "content": "tampered"},
        {**ISSUE_BODY, "operation_id": "invalid"},
        {**ISSUE_BODY, "expected_preview": None},
        {**ISSUE_BODY, "expected_preview": []},
    ],
)
def test_issue_rejects_missing_review_invalid_key_and_extra_fields(body) -> None:
    calls: list[httpx.Request] = []
    assert request("POST", body=body, requests=calls).status_code == 422
    assert calls == []


def test_preview_rejects_forged_customer_fields() -> None:
    assert (
        request(
            "POST", "/preview", body={"template_id": str(TEMPLATE_ID), "customer_name": "forged"}
        ).status_code
        == 422
    )


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
@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("GET", "", None),
        ("POST", "/preview", {"template_id": str(TEMPLATE_ID)}),
        ("POST", "", ISSUE_BODY),
    ],
)
def test_provider_failures_map_without_leaking_details(code, status, method, suffix, body) -> None:
    response = request(
        method,
        suffix,
        body=body,
        provider_status=400,
        provider_body={"code": code, "message": "private patient data", "details": "secret token"},
    )
    assert response.status_code == status
    assert "private" not in response.text
    assert "secret" not in response.text


@pytest.mark.parametrize("payload", [[], [{"bad": True}], "not object", {"template_id": "bad"}])
def test_malformed_preview_is_safe_unavailability(payload) -> None:
    assert (
        request(
            "POST", "/preview", body={"template_id": str(TEMPLATE_ID)}, provider_body=payload
        ).status_code
        == 503
    )


@pytest.mark.parametrize("payload", [{}, [], [ISSUED, ISSUED], [{"id": "bad"}]])
def test_issue_requires_exactly_one_valid_row(payload) -> None:
    assert request("POST", body=ISSUE_BODY, provider_body=payload).status_code == 503
