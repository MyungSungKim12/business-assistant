import asyncio
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_documents import SupabaseDocumentRepository
from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)
from test_document_api import (
    ORGANIZATION_ID,
    TEMPLATE_ID,
    FakeDocumentRepository,
    FakeOrganizationRepository,
    _path,
    _request,
)

PATH = f"{_path('document-templates')}/{TEMPLATE_ID}/mutations"
BODY = {
    "action": "save",
    "expected_revision": 1,
    "operation_id": str(uuid4()),
    "values": {"name": "동의서", "description": "", "content": "본문"},
}


class Repository(FakeDocumentRepository):
    def __init__(self, error=None):
        super().__init__()
        self.calls = []
        self.error = error

    async def mutate_template(self, organization_id, template_id, values):
        self.calls.append((organization_id, template_id, values))
        if self.error:
            raise self.error
        return replace(self.templates[TEMPLATE_ID], revision=2)

    async def list_template_versions(self, organization_id, template_id):
        return []


def test_mutation_routes_scope_and_version_response():
    repo = Repository()
    response = _request("POST", PATH, json=BODY, document_repository=repo)
    assert response.status_code == 200
    assert response.json()["revision"] == 2
    assert repo.calls[0][:2] == (ORGANIZATION_ID, TEMPLATE_ID)
    assert repo.calls[0][2] == BODY


@pytest.mark.parametrize(
    "options,code",
    [
        ({"token": None}, 401),
        ({"token": "outsider-token"}, 403),
        ({"organization_repository": FakeOrganizationRepository(role="member")}, 403),
        ({"organization_repository": FakeOrganizationRepository([])}, 403),
    ],
)
def test_auth_feature_and_role_reject_before_mutation(options, code):
    repo = Repository()
    assert (
        _request("POST", PATH, json=BODY, document_repository=repo, **options).status_code == code
    )
    assert repo.calls == []


@pytest.mark.parametrize(
    "patch",
    [
        {"expected_revision": True},
        {"expected_revision": 0},
        {"action": "bad"},
        {"values": None},
        {"values": {"name": " ", "description": "", "content": ""}},
        {"values": {"name": "x", "description": "", "content": "", "extra": 1}},
        {"action": "publish"},
        {"operation_id": "bad"},
    ],
)
def test_invalid_payload_does_not_reach_repository(patch):
    repo = Repository()
    assert (
        _request("POST", PATH, json={**BODY, **patch}, document_repository=repo).status_code == 422
    )
    assert repo.calls == []


@pytest.mark.parametrize(
    "error,code",
    [
        (RepositoryConflictError(), 409),
        (RepositoryNotFoundError(), 404),
        (RepositoryPermissionError(), 403),
        (RepositoryValidationError(), 422),
        (RepositoryUnavailableError(), 503),
    ],
)
def test_domain_errors_have_actionable_http_status(error, code):
    assert (
        _request("POST", PATH, json=BODY, document_repository=Repository(error)).status_code == code
    )


def test_legacy_patch_cannot_bypass_versions():
    response = _request(
        "PATCH", f"{_path('document-templates')}/{TEMPLATE_ID}", json={"content": "bad"}
    )
    assert response.status_code == 409


def test_member_can_read_history():
    response = _request(
        "GET",
        f"{_path('document-templates')}/{TEMPLATE_ID}/versions",
        document_repository=Repository(),
        organization_repository=FakeOrganizationRepository(role="member"),
    )
    assert response.status_code == 200


def test_adapter_passes_scoped_rpc_and_maps_conflict():
    async def run():
        def handle(request):
            import json

            payload = json.loads(request.content)
            assert request.url.path.endswith("/rpc/mutate_document_template")
            assert payload["p_organization_id"] == str(ORGANIZATION_ID)
            assert payload["p_template_id"] == str(TEMPLATE_ID)
            assert payload["p_operation_id"] == BODY["operation_id"]
            return httpx.Response(400, json={"code": "P0001", "message": "private error"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            repo = SupabaseDocumentRepository("https://test", "key", "token", client)
            with pytest.raises(RepositoryConflictError):
                await repo.mutate_template(ORGANIZATION_ID, TEMPLATE_ID, BODY)

    asyncio.run(run())
