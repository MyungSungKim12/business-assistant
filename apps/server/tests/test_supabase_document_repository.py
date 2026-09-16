import asyncio
import json
from uuid import UUID

import httpx
import pytest
from business_assistant_server.adapters.supabase_documents import SupabaseDocumentRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
USER_ID = UUID("12345678-1234-5678-1234-567812345678")
TEMPLATE_ID = UUID("33333333-3333-3333-3333-333333333333")
DOCUMENT_ID = UUID("44444444-4444-4444-4444-444444444444")


def test_document_adapter_uses_tenant_token_and_scopes_templates_and_documents() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("document_templates"):
            return httpx.Response(200 if request.method == "GET" else 201, json=[_template()])
        return httpx.Response(200 if request.method == "GET" else 201, json=[_document()])

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseDocumentRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            assert len(await repository.list_templates(ORGANIZATION_ID)) == 1
            await repository.create_template(
                ORGANIZATION_ID,
                USER_ID,
                {"name": "Quote", "description": "Sales", "content": "Hello"},
            )
            assert len(await repository.list_documents(ORGANIZATION_ID)) == 1
            await repository.create_document(
                ORGANIZATION_ID,
                USER_ID,
                {"template_id": str(TEMPLATE_ID), "title": "Quote 1", "content": "Body"},
            )
            assert await repository.update_template(ORGANIZATION_ID, TEMPLATE_ID, {"name": "New"})
            assert await repository.update_document(ORGANIZATION_ID, DOCUMENT_ID, {"status": "final"})

    asyncio.run(run())

    assert all(request.headers["authorization"] == "Bearer user-token" for request in requests)
    assert all(request.headers["apikey"] == "publishable-key" for request in requests)
    assert requests[0].url.path == "/rest/v1/document_templates"
    assert requests[0].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert requests[2].url.path == "/rest/v1/documents"
    assert requests[2].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert json.loads(requests[3].content)["organization_id"] == str(ORGANIZATION_ID)
    assert json.loads(requests[5].content) == {"status": "final"}


def test_document_adapter_maps_provider_and_malformed_responses_safely() -> None:
    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500, text="secret"))
        ) as client:
            repository = SupabaseDocumentRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            with pytest.raises(RepositoryUnavailableError):
                await repository.list_documents(ORGANIZATION_ID)

    asyncio.run(run())


def _template() -> dict[str, object]:
    return {
        "id": str(TEMPLATE_ID),
        "organization_id": str(ORGANIZATION_ID),
        "created_by": str(USER_ID),
        "name": "Quote",
        "description": "Sales",
        "content": "Hello",
        "is_archived": False,
        "created_at": "2030-01-01T00:00:00+00:00",
        "updated_at": "2030-01-01T00:00:00+00:00",
    }


def _document() -> dict[str, object]:
    return {
        "id": str(DOCUMENT_ID),
        "organization_id": str(ORGANIZATION_ID),
        "template_id": str(TEMPLATE_ID),
        "created_by": str(USER_ID),
        "title": "Quote 1",
        "content": "Body",
        "status": "draft",
        "created_at": "2030-01-01T00:00:00+00:00",
        "updated_at": "2030-01-01T00:00:00+00:00",
    }
