"""User-token PostgREST access to immutable treatment document snapshots."""

from typing import Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ValidationError

from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)


class TreatmentDocumentPreview(BaseModel):
    template_id: UUID
    template_version: int
    title: str
    content: str
    source_snapshot: dict[str, object]
    missing_fields: list[str]


class IssuedTreatmentDocument(BaseModel):
    # Only public fields survive parsing, including on list responses.
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_id: UUID
    template_id: UUID
    template_version: int
    title: str
    content: str
    source_snapshot: dict[str, object]
    issued_by: UUID
    issued_at: str


class TreatmentDocumentRepository(Protocol):
    async def preview(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID, template_id: UUID
    ) -> TreatmentDocumentPreview: ...

    async def issue(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        template_id: UUID,
        operation_id: UUID,
        expected_preview: dict[str, object],
    ) -> IssuedTreatmentDocument: ...

    async def list_issued(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID
    ) -> list[IssuedTreatmentDocument]: ...


class SupabaseTreatmentDocumentRepository:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {"apikey": publishable_key, "Authorization": f"Bearer {access_token}"}
        self._client = client

    async def preview(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID, template_id: UUID
    ) -> TreatmentDocumentPreview:
        payload = await self._request(
            "POST",
            "rpc/preview_treatment_document",
            json={
                "p_organization_id": str(organization_id),
                "p_customer_id": str(customer_id),
                "p_treatment_id": str(treatment_id),
                "p_template_id": str(template_id),
            },
        )
        try:
            return TreatmentDocumentPreview.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    async def issue(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        template_id: UUID,
        operation_id: UUID,
        expected_preview: dict[str, object],
    ) -> IssuedTreatmentDocument:
        payload = await self._request(
            "POST",
            "rpc/issue_treatment_document",
            json={
                "p_organization_id": str(organization_id),
                "p_customer_id": str(customer_id),
                "p_treatment_id": str(treatment_id),
                "p_template_id": str(template_id),
                "p_operation_id": str(operation_id),
                "p_expected_preview": expected_preview,
            },
        )
        if not isinstance(payload, list) or len(payload) != 1:
            raise RepositoryUnavailableError()
        return self._parse_issued(payload)[0]

    async def list_issued(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID
    ) -> list[IssuedTreatmentDocument]:
        # Distinguish an inaccessible/mismatched parent from a valid empty history.
        parent = await self._request(
            "GET",
            "treatment_records",
            params={
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "id": f"eq.{treatment_id}",
                "select": "id",
            },
        )
        if not isinstance(parent, list):
            raise RepositoryUnavailableError()
        if not parent:
            raise RepositoryNotFoundError()
        if len(parent) != 1 or not isinstance(parent[0], dict):
            raise RepositoryUnavailableError()
        if parent[0].get("id") != str(treatment_id):
            raise RepositoryUnavailableError()
        payload = await self._request(
            "GET",
            "issued_treatment_documents",
            params={
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "treatment_id": f"eq.{treatment_id}",
                "order": "issued_at.desc,id.desc",
            },
        )
        return self._parse_issued(payload)

    @staticmethod
    def _parse_issued(payload: object) -> list[IssuedTreatmentDocument]:
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        try:
            return [IssuedTreatmentDocument.model_validate(row) for row in payload]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
    ) -> object:
        try:
            if self._client is not None:
                response = await self._client.request(
                    method, f"{self._base}/{path}", params=params, json=json, headers=self._headers
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._base}/{path}",
                        params=params,
                        json=json,
                        headers=self._headers,
                    )
            response.raise_for_status()
            payload: object = response.json()
            return payload
        except httpx.HTTPStatusError as error:
            try:
                failure = error.response.json()
                code = failure.get("code") if isinstance(failure, dict) else None
            except ValueError:
                code = None
            mapped = {
                "P0001": RepositoryConflictError,
                "P0002": RepositoryNotFoundError,
                "42501": RepositoryPermissionError,
                "22023": RepositoryValidationError,
                "23514": RepositoryValidationError,
                "22P02": RepositoryValidationError,
            }
            if isinstance(code, str) and code in mapped:
                raise mapped[code]() from error
            raise RepositoryUnavailableError() from error
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
