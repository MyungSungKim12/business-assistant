import asyncio
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.treatments import get_treatment_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_customer_api import FakeAuthAdapter, FakeOrganizationRepository
from test_treatment_api import CUSTOMER_ID, ORGANIZATION_ID, RECORD_ID, VALUES, record


class Repository:
    def __init__(self):
        self.calls = []
        self.error = None

    async def mutate_treatment(self, org, customer, treatment, values):
        self.calls.append((org, customer, treatment, values))
        if self.error:
            raise self.error
        return replace(record(), status="in_progress", version=2)

    async def list_treatment_events(self, org, customer, treatment):
        return []


def request(payload=None, *, repo=None, role="owner", token="owner-token", method="POST"):
    app = create_app()

    class Org(FakeOrganizationRepository):
        async def get_membership(self, user_id, org):
            result = await super().get_membership(user_id, org)
            return role if result else None

    app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
    app.dependency_overrides[get_organization_repository] = lambda: Org()
    app.dependency_overrides[get_treatment_repository] = lambda: repo or Repository()

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            suffix = "mutations" if method == "POST" else "events"
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}/customers/{CUSTOMER_ID}/treatments/{RECORD_ID}/{suffix}",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )

    return asyncio.run(run())


def mutation(**changes):
    return dict(
        action="start",
        expected_version=1,
        operation_id=str(uuid4()),
        reason="",
        values=None,
        **changes,
    )


def test_scoped_mutation_and_lifecycle_response():
    repo = Repository()
    payload = mutation()
    response = request(payload, repo=repo)
    assert response.status_code == 200
    assert response.json()["status"] == "in_progress"
    assert response.json()["version"] == 2
    assert repo.calls[0][:3] == (ORGANIZATION_ID, CUSTOMER_ID, RECORD_ID)
    assert repo.calls[0][3]["operation_id"] == payload["operation_id"]


@pytest.mark.parametrize(
    "changes",
    [
        {"action": "complete", "values": VALUES},
        {"action": "cancel", "reason": "   "},
        {"action": "correct", "reason": "", "values": VALUES},
        {"action": "edit", "values": None},
        {"expected_version": 0},
        {"operation_id": "invalid"},
        {"action": "delete"},
        {"actor_id": str(uuid4())},
    ],
)
def test_invalid_mutations_rejected(changes):
    payload = mutation()
    payload.update(changes)
    assert request(payload).status_code == 422


def test_mutation_role_and_member_event_read():
    assert request(mutation(), role="member").status_code == 403
    assert request(mutation(), token="outsider-token").status_code == 403
    assert request(method="GET", role="member").status_code == 200


def test_conflict_is_distinct_from_outage():
    from business_assistant_server.ports.repositories import (
        RepositoryConflictError,
        RepositoryUnavailableError,
    )

    repo = Repository()
    repo.error = RepositoryConflictError()
    assert request(mutation(), repo=repo).status_code == 409
    repo.error = RepositoryUnavailableError()
    assert request(mutation(), repo=repo).status_code == 503


def test_rpc_normalizes_decimal_notation():
    repo = Repository()
    payload = mutation()
    payload.update(action="edit", values=dict(VALUES, amount="1E+3"))
    assert request(payload, repo=repo).status_code == 200
    assert repo.calls[-1][-1]["values"]["amount"] == "1000.00"
