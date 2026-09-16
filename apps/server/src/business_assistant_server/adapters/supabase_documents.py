"""PostgREST adapter for organization-scoped document data."""

from typing import Any, TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    DocumentSummary,
    DocumentTemplateSummary,
    RepositoryUnavailableError,
)

ModelT = TypeVar("ModelT", bound=BaseModel)


class _TemplateRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    organization_id: UUID
    created_by: UUID
    name: str
    description: str
    content: str
    is_archived: bool
    created_at: str
    updated_at: str


class _DocumentRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    organization_id: UUID
    template_id: UUID | None
    created_by: UUID
    title: str
    content: str
    status: str
    created_at: str
    updated_at: str


class SupabaseDocumentRepository:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._rest_url = f"{supabase_url.rstrip('/')}/rest/v1"
        self._publishable_key = publishable_key
        self._access_token = access_token
        self._client = client

    async def list_templates(self, organization_id: UUID) -> list[DocumentTemplateSummary]:
        rows = await self._request_rows(
            "GET",
            "document_templates",
            params={"organization_id": f"eq.{organization_id}"},
        )
        return [self._template_summary(row) for row in self._parse_rows(rows, _TemplateRow)]

    async def create_template(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary:
        rows = await self._request_rows(
            "POST",
            "document_templates",
            json={**values, "organization_id": str(organization_id), "created_by": str(created_by)},
            headers={"Prefer": "return=representation"},
        )
        return self._template_summary(self._parse_one(rows, _TemplateRow))

    async def update_template(
        self, organization_id: UUID, template_id: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary | None:
        rows = await self._request_rows(
            "PATCH",
            "document_templates",
            params={"id": f"eq.{template_id}", "organization_id": f"eq.{organization_id}"},
            json=values,
            headers={"Prefer": "return=representation"},
        )
        return self._template_summary(self._parse_one(rows, _TemplateRow)) if rows else None

    async def list_documents(self, organization_id: UUID) -> list[DocumentSummary]:
        rows = await self._request_rows(
            "GET", "documents", params={"organization_id": f"eq.{organization_id}"}
        )
        return [self._document_summary(row) for row in self._parse_rows(rows, _DocumentRow)]

    async def create_document(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentSummary:
        rows = await self._request_rows(
            "POST",
            "documents",
            json={**values, "organization_id": str(organization_id), "created_by": str(created_by)},
            headers={"Prefer": "return=representation"},
        )
        return self._document_summary(self._parse_one(rows, _DocumentRow))

    async def update_document(
        self, organization_id: UUID, document_id: UUID, values: dict[str, object]
    ) -> DocumentSummary | None:
        rows = await self._request_rows(
            "PATCH",
            "documents",
            params={"id": f"eq.{document_id}", "organization_id": f"eq.{organization_id}"},
            json=values,
            headers={"Prefer": "return=representation"},
        )
        return self._document_summary(self._parse_one(rows, _DocumentRow)) if rows else None

    async def _request_rows(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        request_headers = {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {self._access_token}",
            **(headers or {}),
        }
        try:
            if self._client is not None:
                response = await self._client.request(
                    method,
                    f"{self._rest_url}/{table}",
                    params=params,
                    json=json,
                    headers=request_headers,
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._rest_url}/{table}",
                        params=params,
                        json=json,
                        headers=request_headers,
                    )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _parse_rows(rows: list[dict[str, Any]], model: type[ModelT]) -> list[ModelT]:
        try:
            return [model.model_validate(row) for row in rows]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    @classmethod
    def _parse_one(cls, rows: list[dict[str, Any]], model: type[ModelT]) -> ModelT:
        if not rows:
            raise RepositoryUnavailableError()
        return cls._parse_rows(rows[:1], model)[0]

    @staticmethod
    def _template_summary(row: _TemplateRow) -> DocumentTemplateSummary:
        return DocumentTemplateSummary(
            row.id,
            row.organization_id,
            row.created_by,
            row.name,
            row.description,
            row.content,
            row.is_archived,
            row.created_at,
            row.updated_at,
        )

    @staticmethod
    def _document_summary(row: _DocumentRow) -> DocumentSummary:
        return DocumentSummary(
            row.id,
            row.organization_id,
            row.template_id,
            row.created_by,
            row.title,
            row.content,
            row.status,
            row.created_at,
            row.updated_at,
        )
