import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_treatments import SupabaseTreatmentRepository
from business_assistant_server.api.treatments import TreatmentMutationRequest, _treatment_response
from pydantic import ValidationError
from test_treatment_api import CUSTOMER_ID, ORGANIZATION_ID, RECORD_ID, VALUES, record
from test_treatment_lifecycle import Repository, request


def consultation(**changes):
    return {
        "goal": "보습 관리",
        "plan": "상태 확인 후 관리",
        "acknowledge_cautions": True,
        "expected_cautions": {"allergies": "향료", "skin_type": None, "concerns": ["건조"]},
        **changes,
    }


def mutation(values=None, **changes):
    return {
        "action": "consult",
        "expected_version": 1,
        "operation_id": str(uuid4()),
        "values": consultation() if values is None else values,
        **changes,
    }


def test_consultation_reaches_existing_mutation_route_with_json_safe_values():
    repo = Repository()
    payload = mutation()
    response = request(payload, repo=repo)
    assert response.status_code == 200
    assert repo.calls[0][:3] == (ORGANIZATION_ID, CUSTOMER_ID, RECORD_ID)
    assert repo.calls[0][3]["values"] == payload["values"]
    assert repo.calls[0][3]["operation_id"] == payload["operation_id"]
    json.dumps(repo.calls[0][3])


@pytest.mark.parametrize("acknowledge", [True, False])
def test_empty_consultation_draft_and_boundaries_allowed(acknowledge):
    for goal, plan in [("", ""), ("가" * 2000, "나" * 5000)]:
        result = TreatmentMutationRequest.model_validate(
            mutation(consultation(goal=goal, plan=plan, acknowledge_cautions=acknowledge))
        )
        assert result.model_dump(mode="json")["values"]["acknowledge_cautions"] is acknowledge


@pytest.mark.parametrize(
    "changes",
    [
        {"goal": "x" * 2001},
        {"plan": "x" * 5001},
        {"goal": None},
        {"plan": 1},
        {"acknowledge_cautions": "true"},
        {"acknowledge_cautions": 1},
        {"acknowledge_cautions": None},
        {"expected_cautions": {}},
        {"expected_cautions": {"allergies": None, "skin_type": None, "concerns": []}},
        {"expected_cautions": {"allergies": "", "skin_type": 1, "concerns": []}},
        {"expected_cautions": {"allergies": "", "skin_type": None, "concerns": "dry"}},
        {"expected_cautions": {"allergies": "", "skin_type": None, "concerns": [1]}},
        {"expected_cautions": {"allergies": "", "skin_type": None, "concerns": [], "extra": 1}},
        {"cautions_acknowledged_by": str(uuid4())},
    ],
)
def test_invalid_consultation_never_reaches_repository(changes):
    repo = Repository()
    assert request(mutation(consultation(**changes)), repo=repo).status_code == 422
    assert repo.calls == []


@pytest.mark.parametrize("key", ["goal", "plan", "acknowledge_cautions", "expected_cautions"])
def test_consultation_requires_exact_fields(key):
    values = consultation()
    del values[key]
    with pytest.raises(ValidationError):
        TreatmentMutationRequest.model_validate(mutation(values))


@pytest.mark.parametrize("action", ["edit", "correct", "start", "complete", "cancel"])
def test_other_actions_cannot_accept_consultation_values(action):
    with pytest.raises(ValidationError):
        TreatmentMutationRequest.model_validate(mutation(action=action, reason="reason"))


def test_consult_requires_consultation_not_treatment_values():
    with pytest.raises(ValidationError):
        TreatmentMutationRequest.model_validate(mutation(VALUES))
    payload = mutation()
    payload["values"] = None
    with pytest.raises(ValidationError):
        TreatmentMutationRequest.model_validate(payload)


def test_consultation_enforces_existing_role_and_organization_checks():
    repo = Repository()
    assert request(mutation(), repo=repo, role="member").status_code == 403
    assert request(mutation(), repo=repo, token="outsider-token").status_code == 403
    assert repo.calls == []


def test_consultation_fields_survive_rpc_and_read_projection():
    actor = str(uuid4())
    row = _treatment_response(record()).model_dump(mode="json")
    row.update(
        consultation_goal="보습",
        consultation_plan="확인 후 관리",
        cautions_snapshot={"allergies": "향료", "skin_type": None, "concerns": ["건조"]},
        cautions_acknowledged_by=actor,
        cautions_acknowledged_at="2026-09-22T01:00:00+00:00",
    )
    payload = TreatmentMutationRequest.model_validate(mutation()).model_dump(mode="json")

    def handler(req):
        if req.method == "GET":
            assert set(row).issubset(set(req.url.params["select"].split(",")))
        else:
            assert req.url.path == "/rest/v1/rpc/mutate_treatment"
            body = json.loads(req.content)
            assert body["p_action"] == "consult"
            assert body["p_values"] == payload["values"]
            assert body["p_operation_id"] == payload["operation_id"]
        return httpx.Response(200, json=[row])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            repo = SupabaseTreatmentRepository("https://example.test", "key", "token", client)
            saved = await repo.mutate_treatment(ORGANIZATION_ID, CUSTOMER_ID, RECORD_ID, payload)
            listed = (await repo.list_treatments(ORGANIZATION_ID, CUSTOMER_ID))[0]
        for item in [saved, listed]:
            response = _treatment_response(item).model_dump(mode="json")
            for key in row:
                assert response[key] == row[key]

    asyncio.run(run())


def test_old_record_has_unacknowledged_consultation_defaults():
    first, second = record(), record()
    assert first.cautions_snapshot is not second.cautions_snapshot
    response = _treatment_response(first).model_dump(mode="json")
    assert response["consultation_goal"] == ""
    assert response["consultation_plan"] == ""
    assert response["cautions_snapshot"] == {}
    assert response["cautions_acknowledged_by"] is None
    assert response["cautions_acknowledged_at"] is None
