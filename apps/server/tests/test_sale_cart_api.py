import asyncio
from copy import deepcopy
from uuid import UUID, uuid4

import httpx
import pytest
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.sale_carts import get_sale_cart_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import RepositoryConflictError
from test_document_api import (
    ORGANIZATION_ID,
    FakeAuthAdapter,
    FakeOrganizationRepository,
)

CUSTOMER_ID = UUID("55555555-5555-5555-5555-555555555555")
VISIT_ID = UUID("66666666-6666-6666-6666-666666666666")
DRAFT_ID = UUID("77777777-7777-7777-7777-777777777777")
LINE_ID = UUID("88888888-8888-8888-8888-888888888888")
OPERATION_ID = UUID("99999999-9999-9999-9999-999999999999")
FEATURES = ["crm.basic", "finance.basic"]


def bundle(version: int = 1) -> dict[str, object]:
    return {
        "visit": {
            "id": str(VISIT_ID),
            "organization_id": str(ORGANIZATION_ID),
            "customer_id": str(CUSTOMER_ID),
            "appointment_id": None,
            "status": "open",
            "opened_at": "2030-01-01T00:00:00Z",
            "closed_at": None,
            "version": 1,
        },
        "cart": {
            "id": str(uuid4()),
            "organization_id": str(ORGANIZATION_ID),
            "visit_id": str(VISIT_ID),
            "customer_id": str(CUSTOMER_ID),
            "status": "draft",
            "version": version,
            "subtotal": "0.00",
            "discount_total": "0.00",
            "total_amount": "0.00",
        },
        "lines": [],
    }


class FakeSaleCartRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.result = bundle()
        self.error: Exception | None = None

    async def list_visits(self, organization_id, customer_id=None, status=None):
        self.calls.append(("list", organization_id, customer_id, status))
        return [self.result["visit"]]

    async def create_visit(self, organization_id, customer_id, operation_id):
        self.calls.append(("create", organization_id, customer_id, operation_id))
        if self.error:
            raise self.error
        return self.result

    async def get_cart(self, organization_id, visit_id):
        self.calls.append(("get", organization_id, visit_id))
        return self.result

    async def add_treatment_draft(
        self, organization_id, visit_id, draft_id, expected_version, operation_id
    ):
        self.calls.append(
            ("add", organization_id, visit_id, draft_id, expected_version, operation_id)
        )
        return self.result

    async def mutate_line(
        self,
        organization_id,
        visit_id,
        line_id,
        expected_version,
        operation_id,
        action,
        values,
    ):
        self.calls.append(
            (
                "line",
                organization_id,
                visit_id,
                line_id,
                expected_version,
                operation_id,
                action,
                deepcopy(values),
            )
        )
        return self.result

    async def review(self, organization_id, visit_id, expected_version, operation_id, ready):
        self.calls.append(
            ("review", organization_id, visit_id, expected_version, operation_id, ready)
        )
        return self.result

    async def cancel_visit(self, organization_id, visit_id, expected_version, operation_id):
        self.calls.append(("cancel", organization_id, visit_id, expected_version, operation_id))
        return self.result


def request(method: str, path: str, *, body=None, role="owner", features=None, repository=None):
    repo = repository or FakeSaleCartRepository()

    async def send():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            FEATURES if features is None else features, role
        )
        app.dependency_overrides[get_sale_cart_repository] = lambda: repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}{path}",
                json=body,
                headers={"Authorization": "Bearer owner-token"},
            )

    return asyncio.run(send()), repo


def test_member_reads_but_only_manager_mutates() -> None:
    response, _ = request("GET", "/visits", role="member")
    assert response.status_code == 200
    response, repo = request(
        "POST",
        f"/customers/{CUSTOMER_ID}/visits",
        role="member",
        body={"operation_id": str(OPERATION_ID)},
    )
    assert response.status_code == 403
    assert repo.calls == []


@pytest.mark.parametrize("missing", FEATURES)
def test_every_route_requires_both_features(missing: str) -> None:
    response, repo = request("GET", "/visits", features=[f for f in FEATURES if f != missing])
    assert response.status_code == 403
    assert repo.calls == []


def test_create_and_mutations_forward_scope_version_and_operation() -> None:
    response, repo = request(
        "POST",
        f"/customers/{CUSTOMER_ID}/visits",
        body={"operation_id": str(OPERATION_ID)},
    )
    assert response.status_code == 201
    assert repo.calls == [("create", ORGANIZATION_ID, CUSTOMER_ID, OPERATION_ID)]

    response, repo = request(
        "POST",
        f"/visits/{VISIT_ID}/sale-cart/lines/treatment-draft",
        body={
            "draft_id": str(DRAFT_ID),
            "expected_version": 3,
            "operation_id": str(OPERATION_ID),
        },
    )
    assert response.status_code == 200
    assert repo.calls[0] == ("add", ORGANIZATION_ID, VISIT_ID, DRAFT_ID, 3, OPERATION_ID)

    response, repo = request(
        "PATCH",
        f"/visits/{VISIT_ID}/sale-cart/lines/{LINE_ID}",
        body={
            "expected_version": 4,
            "operation_id": str(OPERATION_ID),
            "quantity": 2,
            "unit_price": "100.25",
            "staff_id": None,
            "staff_name": "담당자",
        },
    )
    assert response.status_code == 200
    assert repo.calls[0][-2:] == (
        "update",
        {
            "quantity": 2,
            "unit_price": "100.25",
            "staff_id": None,
            "staff_name": "담당자",
        },
    )


def test_conflict_is_sanitized() -> None:
    repo = FakeSaleCartRepository()
    repo.error = RepositoryConflictError()
    response, _ = request(
        "POST",
        f"/customers/{CUSTOMER_ID}/visits",
        body={"operation_id": str(OPERATION_ID)},
        repository=repo,
    )
    assert response.status_code == 409
    assert "conflict" in response.json()["detail"].lower()


@pytest.mark.parametrize("value", [True, "2", 1.5, None, 0])
def test_rejects_invalid_expected_version(value):
    response, repo = request(
        "POST",
        f"/visits/{VISIT_ID}/sale-cart/review",
        body={
            "expected_version": value,
            "operation_id": str(OPERATION_ID),
            "ready": True,
        },
    )
    assert response.status_code == 422
    assert not repo.calls


@pytest.mark.parametrize(
    "field,value",
    [
        ("quantity", True),
        ("quantity", "2"),
        ("quantity", None),
        ("unit_price", None),
        ("unit_price", "1.001"),
        ("unit_price", "NaN"),
        ("staff_name", None),
    ],
)
def test_rejects_invalid_line_input(field, value):
    response, repo = request(
        "PATCH",
        f"/visits/{VISIT_ID}/sale-cart/lines/{LINE_ID}",
        body={
            "expected_version": 1,
            "operation_id": str(OPERATION_ID),
            field: value,
        },
    )
    assert response.status_code == 422
    assert not repo.calls


def test_rejects_whitespace_removal_reason():
    response, repo = request(
        "POST",
        f"/visits/{VISIT_ID}/sale-cart/lines/{LINE_ID}/remove",
        body={
            "expected_version": 1,
            "operation_id": str(OPERATION_ID),
            "reason": "   ",
        },
    )
    assert response.status_code == 422
    assert not repo.calls


def test_cart_drafts_read_does_not_require_document_editing_feature():
    from business_assistant_server.api.treatment_sale_drafts import (
        get_treatment_sale_draft_repository,
    )

    calls = []

    class Drafts:
        async def list_drafts(self, org):
            calls.append(org)
            return []

    async def send():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            FEATURES, "member"
        )
        app.dependency_overrides[get_treatment_sale_draft_repository] = Drafts
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.get(
                f"/api/v1/organizations/{ORGANIZATION_ID}/sale-cart-drafts",
                headers={"Authorization": "Bearer owner-token"},
            )

    response = asyncio.run(send())
    assert response.status_code == 200
    assert calls == [ORGANIZATION_ID]
