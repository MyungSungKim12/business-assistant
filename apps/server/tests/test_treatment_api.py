import asyncio
import json
from dataclasses import replace
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.treatments import get_treatment_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import (
    RepositoryUnavailableError,
    TreatmentSummary,
)
from test_customer_api import (
    CUSTOMER_ID,
    ORGANIZATION_ID,
    OTHER_ORGANIZATION_ID,
    FakeAuthAdapter,
    FakeOrganizationRepository,
)

RECORD_ID = uuid4()
VALUES = dict(
    treatment_date="2026-09-18",
    treatment_name="수분 관리",
    category="피부",
    practitioner="김담당",
    notes="보습 위주",
    amount="15000.50",
    next_visit_date="2026-10-01",
)


def record():
    return TreatmentSummary(
        RECORD_ID,
        ORGANIZATION_ID,
        CUSTOMER_ID,
        "2026-09-18",
        "수분 관리",
        "피부",
        "김담당",
        "보습 위주",
        Decimal("15000.50"),
        "2026-10-01",
    )


class Repository:
    calls = None
    missing = False
    fail = False

    async def list_treatments(self, org, customer):
        return [record()]

    async def create_treatment(self, org, customer, values):
        self.calls = values
        json.dumps(values)  # Exact payload must be JSON-safe for PostgREST.
        if self.fail:
            raise RepositoryUnavailableError()
        return record()

    async def update_treatment(self, org, customer, treatment, values):
        self.calls = (org, customer, treatment, values)
        if self.fail:
            raise RepositoryUnavailableError()
        return None if self.missing else replace(record(), notes=values["notes"])


def request(
    method,
    values=None,
    *,
    token="owner-token",
    org=ORGANIZATION_ID,
    repo=None,
    role="owner",
    features=None,
):
    app = create_app()

    class Org(FakeOrganizationRepository):
        async def get_membership(self, user_id, organization_id):
            result = await super().get_membership(user_id, organization_id)
            return role if result else None

    repository = repo or Repository()
    app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
    app.dependency_overrides[get_organization_repository] = lambda: Org(features)
    app.dependency_overrides[get_treatment_repository] = lambda: repository

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            route = f"/api/v1/organizations/{org}/customers/{CUSTOMER_ID}/treatments"
            if method == "PATCH":
                route += f"/{RECORD_ID}"
            return await client.request(
                method,
                route,
                json=dict(values, expected_version=1) if method == "PATCH" and values else values,
                headers={"Authorization": f"Bearer {token}"} if token else {},
            )

    return asyncio.run(run())


def test_create_has_json_safe_decimal_and_date():
    repo = Repository()
    response = request("POST", VALUES, repo=repo)
    assert response.status_code == 201
    assert repo.calls["amount"] == "15000.50"
    assert repo.calls["treatment_date"] == "2026-09-18"


@pytest.mark.parametrize(
    "field,value",
    [
        ("treatment_name", "  "),
        ("treatment_date", "2026-02-31"),
        ("next_visit_date", "invalid"),
        ("next_visit_date", "2026-09-17"),
        ("amount", "-1"),
        ("amount", "1000000000000"),
        ("amount", "1.001"),
        ("notes", "a" * 10001),
    ],
)
def test_invalid_input_rejected(field, value):
    assert request("POST", dict(VALUES, **{field: value})).status_code == 422


def test_scoped_update_and_missing_record():
    repo = Repository()
    response = request("PATCH", dict(VALUES, notes="정정 내용"), repo=repo)
    assert response.status_code == 200
    assert response.json()["id"] == str(RECORD_ID)
    assert repo.calls[:3] == (ORGANIZATION_ID, CUSTOMER_ID, RECORD_ID)
    repo.missing = True
    assert request("PATCH", VALUES, repo=repo).status_code == 404


@pytest.mark.parametrize("method", ["POST", "PATCH"])
def test_permissions_and_unavailable(method):
    assert request(method, VALUES, token=None).status_code == 401
    assert request(method, VALUES, token="outsider-token").status_code == 403
    assert request(method, VALUES, role="member").status_code == 403
    assert request(method, VALUES, org=OTHER_ORGANIZATION_ID).status_code in (403, 404)
    assert request(method, VALUES, features=[]).status_code == 403
    repo = Repository()
    repo.fail = True
    assert request(method, VALUES, repo=repo).status_code == 503


def test_member_can_read_history():
    assert request("GET", role="member").status_code == 200
