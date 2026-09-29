"""User-token access to append-only issued-document consent evidence."""

from typing import Literal, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, Field, ValidationError

from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)


class DocumentConsentEvent(BaseModel):
    # Parsing deliberately strips operation_id and request_fingerprint.
    id: UUID
    organization_id: UUID
    document_id: UUID
    revision: int = Field(strict=True, ge=1)
    action: Literal["sign", "deliver", "revoke"]
    values: dict[str, object]
    actor_id: UUID
    occurred_at: str
    content_hash: str


class DocumentConsentRepository(Protocol):
    async def list_events(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID, document_id: UUID
    ) -> list[DocumentConsentEvent]: ...

    async def record_event(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
        expected_revision: int,
        operation_id: UUID,
        action: str,
        values: dict[str, object],
    ) -> DocumentConsentEvent: ...


class SupabaseDocumentConsentRepository:
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

    async def list_events(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID, document_id: UUID
    ) -> list[DocumentConsentEvent]:
        parent = await self._request(
            "GET",
            "issued_treatment_documents",
            params={
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "treatment_id": f"eq.{treatment_id}",
                "id": f"eq.{document_id}",
                "select": "id",
            },
        )
        if not isinstance(parent, list):
            raise RepositoryUnavailableError()
        if not parent:
            raise RepositoryNotFoundError()
        if len(parent) != 1 or not isinstance(parent[0], dict):
            raise RepositoryUnavailableError()
        if parent[0].get("id") != str(document_id):
            raise RepositoryUnavailableError()
        events: list[DocumentConsentEvent] = []
        while True:
            payload = await self._request(
                "GET",
                "treatment_document_events",
                params={
                    "organization_id": f"eq.{organization_id}",
                    "document_id": f"eq.{document_id}",
                    "order": "revision.asc",
                    "limit": "250",
                    "offset": str(len(events)),
                },
            )
            page = self._parse_events(payload)
            if any(event.revision != len(events) + index + 1 for index, event in enumerate(page)):
                raise RepositoryUnavailableError()
            events.extend(page)
            if len(page) < 250:
                return events

    async def record_event(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
        expected_revision: int,
        operation_id: UUID,
        action: str,
        values: dict[str, object],
    ) -> DocumentConsentEvent:
        payload = await self._request(
            "POST",
            "rpc/record_treatment_document_event",
            json={
                "p_organization_id": str(organization_id),
                "p_customer_id": str(customer_id),
                "p_treatment_id": str(treatment_id),
                "p_document_id": str(document_id),
                "p_expected_revision": expected_revision,
                "p_operation_id": str(operation_id),
                "p_action": action,
                "p_values": values,
            },
        )
        if not isinstance(payload, list) or len(payload) != 1:
            raise RepositoryUnavailableError()
        return self._parse_events(payload)[0]

    @staticmethod
    def _parse_events(payload: object) -> list[DocumentConsentEvent]:
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        try:
            return [DocumentConsentEvent.model_validate(row) for row in payload]
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
