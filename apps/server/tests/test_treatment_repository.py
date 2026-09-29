import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_treatments import SupabaseTreatmentRepository
from business_assistant_server.ports.repositories import (
    RepositoryNotFoundError,
    RepositoryUnavailableError,
)

ORG, CUSTOMER, RECORD = uuid4(), uuid4(), uuid4()
ROW = dict(
    id=str(RECORD),
    organization_id=str(ORG),
    customer_id=str(CUSTOMER),
    treatment_date="2026-09-18",
    treatment_name="수분 관리",
    category="피부",
    practitioner="담당",
    notes="수정",
    amount="15000.50",
    next_visit_date=None,
)


def test_scoped_treatment_patch_uses_tenant_token():
    calls = []

    def respond(req):
        calls.append(req)
        return httpx.Response(200, json=[ROW])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repo = SupabaseTreatmentRepository(
                "https://project.test", "public", "user-token", client
            )
            item = await repo.update_treatment(
                ORG, CUSTOMER, RECORD, {"notes": "수정", "expected_version": 1}
            )
            assert item.id == RECORD

    asyncio.run(run())
    req = calls[0]
    payload = json.loads(req.content)
    assert req.url.path.endswith("/rpc/mutate_treatment")
    assert payload["p_organization_id"] == str(ORG)
    assert payload["p_customer_id"] == str(CUSTOMER)
    assert payload["p_treatment_id"] == str(RECORD)
    assert payload["p_expected_version"] == 1
    assert payload["p_values"] == {"notes": "수정"}
    assert req.headers["Authorization"] == "Bearer user-token"


def test_empty_create_and_missing_patch():
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[]))
        ) as client:
            repo = SupabaseTreatmentRepository("https://project.test", "public", "user", client)
            with pytest.raises(RepositoryNotFoundError):
                await repo.update_treatment(ORG, CUSTOMER, RECORD, {"expected_version": 1})
            with pytest.raises(RepositoryUnavailableError):
                await repo.create_treatment(ORG, CUSTOMER, {})

    asyncio.run(run())


@pytest.mark.parametrize(
    "code,expected",
    [
        ("P0001", "RepositoryConflictError"),
        ("P0002", "RepositoryNotFoundError"),
        ("42501", "RepositoryPermissionError"),
        ("22023", "RepositoryValidationError"),
        ("22008", "RepositoryValidationError"),
        ("23514", "RepositoryValidationError"),
        ("XX000", "RepositoryUnavailableError"),
    ],
)
def test_rpc_database_error_mapping(code, expected):
    from business_assistant_server.ports import repositories

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(400, json={"code": code}))
        ) as client:
            repo = SupabaseTreatmentRepository("https://project.test", "public", "user", client)
            with pytest.raises(getattr(repositories, expected)):
                await repo.mutate_treatment(
                    ORG,
                    CUSTOMER,
                    RECORD,
                    {
                        "action": "start",
                        "expected_version": 1,
                        "operation_id": str(uuid4()),
                        "reason": "",
                        "values": None,
                    },
                )

    asyncio.run(run())


def test_audit_select_scopes_customer_and_record():
    calls = []

    def respond(req):
        calls.append(req)
        return httpx.Response(200, json=[])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repo = SupabaseTreatmentRepository("https://project.test", "public", "user", client)
            assert await repo.list_treatment_events(ORG, CUSTOMER, RECORD) == []

    asyncio.run(run())
    assert calls[0].url.params["organization_id"] == f"eq.{ORG}"
    assert calls[0].url.params["customer_id"] == f"eq.{CUSTOMER}"
    assert calls[0].url.params["treatment_id"] == f"eq.{RECORD}"
