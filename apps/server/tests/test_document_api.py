import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.documents import get_document_repository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import (
    DocumentSummary,
    DocumentTemplateSummary,
    RepositoryUnavailableError,
    SubscriptionSummary,
)

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
OUTSIDER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
TEMPLATE_ID = UUID("33333333-3333-3333-3333-333333333333")
DOCUMENT_ID = UUID("44444444-4444-4444-4444-444444444444")


class FakeAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token == "owner-token":
            return AuthUser(OWNER_ID, "owner@example.com", "Owner")
        if access_token == "outsider-token":
            return AuthUser(OUTSIDER_ID, "outsider@example.com", "Outsider")
        raise AuthenticationError()


class FakeOrganizationRepository:
    def __init__(self, features: list[str] | None = None, role: str | None = "owner") -> None:
        self.features = ["document.template"] if features is None else features
        self.role = role

    async def organization_exists(self, organization_id: UUID) -> bool:
        return organization_id == ORGANIZATION_ID

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        if user_id == OWNER_ID and organization_id == ORGANIZATION_ID:
            return self.role
        return None

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        del now
        return SubscriptionSummary(
            organization_id,
            "BASIC",
            "active",
            datetime.now(UTC) + timedelta(days=1),
            self.features,
        )


class FakeDocumentRepository:
    def __init__(self) -> None:
        self.templates = {
            TEMPLATE_ID: DocumentTemplateSummary(
                TEMPLATE_ID,
                ORGANIZATION_ID,
                OWNER_ID,
                "Quote",
                "Sales template",
                "Hello",
                False,
                "2030-01-01T00:00:00+00:00",
                "2030-01-01T00:00:00+00:00",
            )
        }
        self.documents = {
            DOCUMENT_ID: DocumentSummary(
                DOCUMENT_ID,
                ORGANIZATION_ID,
                TEMPLATE_ID,
                OWNER_ID,
                "Quote 1",
                "Body",
                "draft",
                "2030-01-01T00:00:00+00:00",
                "2030-01-01T00:00:00+00:00",
            )
        }

    async def list_templates(self, organization_id: UUID) -> list[DocumentTemplateSummary]:
        return [item for item in self.templates.values() if item.organization_id == organization_id]

    async def create_template(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary:
        template = DocumentTemplateSummary(
            uuid4(),
            organization_id,
            created_by,
            str(values["name"]),
            str(values.get("description", "")),
            str(values.get("content", "")),
            bool(values.get("is_archived", False)),
            "2030-01-01T00:00:00+00:00",
            "2030-01-01T00:00:00+00:00",
        )
        self.templates[template.id] = template
        return template

    async def update_template(
        self, organization_id: UUID, template_id: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary | None:
        template = self.templates.get(template_id)
        if template is None or template.organization_id != organization_id:
            return None
        updated = DocumentTemplateSummary(
            template.id,
            template.organization_id,
            template.created_by,
            str(values.get("name", template.name)),
            str(values.get("description", template.description)),
            str(values.get("content", template.content)),
            bool(values.get("is_archived", template.is_archived)),
            template.created_at,
            "2030-01-02T00:00:00+00:00",
        )
        self.templates[template_id] = updated
        return updated

    async def list_documents(self, organization_id: UUID) -> list[DocumentSummary]:
        return [item for item in self.documents.values() if item.organization_id == organization_id]

    async def create_document(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentSummary:
        document = DocumentSummary(
            uuid4(),
            organization_id,
            values.get("template_id"),
            created_by,
            str(values["title"]),
            str(values.get("content", "")),
            str(values.get("status", "draft")),
            "2030-01-01T00:00:00+00:00",
            "2030-01-01T00:00:00+00:00",
        )
        self.documents[document.id] = document
        return document

    async def update_document(
        self, organization_id: UUID, document_id: UUID, values: dict[str, object]
    ) -> DocumentSummary | None:
        document = self.documents.get(document_id)
        if document is None or document.organization_id != organization_id:
            return None
        updated = DocumentSummary(
            document.id,
            document.organization_id,
            values.get("template_id", document.template_id),
            document.created_by,
            str(values.get("title", document.title)),
            str(values.get("content", document.content)),
            str(values.get("status", document.status)),
            document.created_at,
            "2030-01-02T00:00:00+00:00",
        )
        self.documents[document_id] = updated
        return updated


class UnavailableDocumentRepository(FakeDocumentRepository):
    async def list_documents(self, organization_id: UUID) -> list[DocumentSummary]:
        del organization_id
        raise RepositoryUnavailableError()


def _request(
    method: str,
    path: str,
    *,
    organization_repository: FakeOrganizationRepository | None = None,
    document_repository: FakeDocumentRepository | None = None,
    token: str | None = "owner-token",
    json: object = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: (
            organization_repository or FakeOrganizationRepository()
        )
        app.dependency_overrides[get_document_repository] = lambda: (
            document_repository or FakeDocumentRepository()
        )
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            return await client.request(method, path, headers=headers, json=json)

    return asyncio.run(send())


def _path(kind: str, organization_id: UUID = ORGANIZATION_ID) -> str:
    return f"/api/v1/organizations/{organization_id}/{kind}"


def test_documents_require_auth_membership_and_feature() -> None:
    assert _request("GET", _path("documents"), token=None).status_code == 401
    assert _request("GET", _path("documents"), token="outsider-token").status_code == 403
    assert (
        _request(
            "GET", _path("documents"), organization_repository=FakeOrganizationRepository([])
        ).status_code
        == 403
    )


def test_document_template_and_document_crud() -> None:
    repository = FakeDocumentRepository()
    created_template = _request(
        "POST",
        _path("document-templates"),
        document_repository=repository,
        json={"name": " New template ", "content": "Body"},
    )
    assert created_template.status_code == 201
    assert created_template.json()["name"] == "New template"
    created_document = _request(
        "POST",
        _path("documents"),
        document_repository=repository,
        json={"title": " New doc ", "template_id": str(TEMPLATE_ID)},
    )
    assert created_document.status_code == 201
    document_id = created_document.json()["id"]
    updated = _request(
        "PATCH",
        f"{_path('documents')}/{document_id}",
        document_repository=repository,
        json={"status": "final"},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "final"
    assert _request("GET", _path("documents"), document_repository=repository).status_code == 200


def test_documents_validate_payload_and_manager_role() -> None:
    repository = FakeDocumentRepository()
    for payload in ({"title": ""}, {"title": None}, {"title": "Doc", "status": "bad"}):
        assert (
            _request(
                "POST", _path("documents"), document_repository=repository, json=payload
            ).status_code
            == 422
        )
    assert (
        _request(
            "POST",
            _path("documents"),
            organization_repository=FakeOrganizationRepository(role="member"),
            document_repository=repository,
            json={"title": "Doc"},
        ).status_code
        == 403
    )


def test_document_provider_error_is_safe() -> None:
    response = _request(
        "GET", _path("documents"), document_repository=UnavailableDocumentRepository()
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Document service unavailable"}
