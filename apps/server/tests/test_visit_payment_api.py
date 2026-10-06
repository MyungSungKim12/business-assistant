import asyncio
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.visit_payments import get_visit_payment_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import RepositoryConflictError
from test_document_api import ORGANIZATION_ID, FakeAuthAdapter, FakeOrganizationRepository

VISIT = uuid4()
OP = uuid4()
RESULT = dict(
    visit_id=str(VISIT),
    cart_id=str(uuid4()),
    cart_version=3,
    total_amount="100000",
    paid_amount="0",
    outstanding_amount="100000",
    currency="KRW",
    status="ready",
    receipts=[],
)


class Repo:
    def __init__(self):
        self.calls = []
        self.error = None

    async def get_payments(self, *args):
        self.calls.append(args)
        return RESULT

    async def record_payment(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return RESULT


def send(method="POST", *, body=None, role="owner", features=None, repo=None):
    repo = repo or Repo()

    async def run():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["crm.basic", "finance.basic"] if features is None else features, role
        )
        app.dependency_overrides[get_visit_payment_repository] = lambda: repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}/visits/{VISIT}/payments",
                headers={"Authorization": "Bearer owner-token"},
                json=body,
            )

    return asyncio.run(run()), repo


def payload():
    return dict(
        expected_version=3,
        operation_id=str(OP),
        confirmed=True,
        payments=[
            dict(method="card", amount="70000", reference="approval-1"),
            dict(method="cash", amount="30000", reference=""),
        ],
    )


def test_records_split_receipt_with_scope_and_idempotency():
    response, repo = send(body=payload())
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, VISIT, 3, OP, payload()["payments"], True)]


def test_member_reads_but_cannot_record():
    assert send("GET", role="member")[0].status_code == 200
    response, repo = send(role="member", body=payload())
    assert response.status_code == 403
    assert not repo.calls


@pytest.mark.parametrize("features", [[], ["finance.basic"], ["crm.basic"]])
def test_requires_both_features(features):
    response, repo = send(body=payload(), features=features)
    assert response.status_code == 403
    assert not repo.calls


@pytest.mark.parametrize(
    "amount", ["0", "-1", "0.01", "NaN", "1e3", "01", 100, None, "1000000000000"]
)
def test_invalid_money_never_reaches_repository(amount):
    body = payload()
    body["payments"][0]["amount"] = amount
    response, repo = send(body=body)
    assert response.status_code == 422
    assert not repo.calls


@pytest.mark.parametrize(
    "change", ["unconfirmed", "missing_reference", "duplicate", "bool_version"]
)
def test_invalid_contract_never_reaches_repository(change):
    body = payload()
    if change == "unconfirmed":
        body["confirmed"] = False
    elif change == "missing_reference":
        body["payments"][0]["reference"] = "   "
    elif change == "duplicate":
        body["payments"].append(body["payments"][0])
    else:
        body["expected_version"] = True
    response, repo = send(body=body)
    assert response.status_code == 422
    assert not repo.calls


def test_conflict_is_safe_to_show():
    repo = Repo()
    repo.error = RepositoryConflictError()
    response, _ = send(body=payload(), repo=repo)
    assert response.status_code == 409
