"""Immutable sale handoffs through user-token PostgREST RPCs."""

import json as json_module
from decimal import Decimal
from typing import Annotated, Literal, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)


class TreatmentSaleValues(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    description: Annotated[str, Field(min_length=1, max_length=200)]
    amount: Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$")]
    consent_document_id: str | None
    exception_reason: Annotated[str, Field(max_length=2000)]
    partial_reason: Annotated[str, Field(max_length=2000)]

    @field_validator("description")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("description is required")
        return value

    @field_validator("consent_document_id")
    @classmethod
    def document_uuid(cls, value: str | None) -> str | None:
        if value is not None:
            UUID(value)
        return value


class TreatmentSaleLine(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    description: str
    quantity: Literal[1]
    unit_price: str
    line_total: str
    practitioner: str


class TreatmentSaleDraftPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    values: TreatmentSaleValues
    line: TreatmentSaleLine
    total_amount: str
    source_snapshot: dict[str, object]
    consent_status: Literal["not_linked", "unsigned", "signed", "revoked"]
    warnings: list[str]


class TreatmentSaleDraft(BaseModel):
    # Retry fingerprints and operation IDs are deliberately not public fields.
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_id: UUID
    status: Literal["draft"]
    description: str
    amount: Decimal
    source_snapshot: dict[str, object]
    created_by: UUID
    created_at: str


class TreatmentSaleDraftRepository(Protocol):
    async def preview(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> TreatmentSaleDraftPreview: ...

    async def create(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        operation_id: UUID,
        expected_preview: dict[str, object],
        confirmed: bool,
    ) -> TreatmentSaleDraft: ...

    async def list_drafts(
        self,
        organization_id: UUID,
        customer_id: UUID | None = None,
        treatment_id: UUID | None = None,
    ) -> list[TreatmentSaleDraft]: ...


class SupabaseTreatmentSaleDraftRepository:
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
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> TreatmentSaleDraftPreview:
        payload = await self._request(
            "POST",
            "rpc/preview_treatment_sale_draft",
            json={
                "p_organization_id": str(organization_id),
                "p_customer_id": str(customer_id),
                "p_treatment_id": str(treatment_id),
                "p_values": values,
            },
        )
        try:
            return TreatmentSaleDraftPreview.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    async def create(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        operation_id: UUID,
        expected_preview: dict[str, object],
        confirmed: bool,
    ) -> TreatmentSaleDraft:
        payload = await self._request(
            "POST",
            "rpc/create_treatment_sale_draft",
            json={
                "p_organization_id": str(organization_id),
                "p_customer_id": str(customer_id),
                "p_treatment_id": str(treatment_id),
                "p_operation_id": str(operation_id),
                "p_expected_preview": expected_preview,
                "p_confirmed": confirmed,
            },
        )
        if not isinstance(payload, list) or len(payload) != 1:
            raise RepositoryUnavailableError()
        return self._parse(payload)[0]

    async def list_drafts(
        self,
        organization_id: UUID,
        customer_id: UUID | None = None,
        treatment_id: UUID | None = None,
    ) -> list[TreatmentSaleDraft]:
        params = {
            "organization_id": f"eq.{organization_id}",
            "status": "eq.draft",
            "order": "created_at.desc,id.desc",
        }
        if (customer_id is None) != (treatment_id is None):
            raise RepositoryValidationError()
        if customer_id is not None and treatment_id is not None:
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
            params.update(customer_id=f"eq.{customer_id}", treatment_id=f"eq.{treatment_id}")
            rows = self._parse(await self._request("GET", "treatment_sale_drafts", params=params))
            if len(rows) > 1:
                raise RepositoryUnavailableError()
            return rows
        # Continue even if a provider has a lower row cap than our requested page size.
        rows: list[TreatmentSaleDraft] = []
        while True:
            page = self._parse(
                await self._request(
                    "GET",
                    "treatment_sale_drafts",
                    params={**params, "limit": "500", "offset": str(len(rows))},
                )
            )
            if not page:
                return rows
            if {row.id for row in page} & {row.id for row in rows}:
                raise RepositoryUnavailableError()
            rows.extend(page)

    @staticmethod
    def _parse(payload: object) -> list[TreatmentSaleDraft]:
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        try:
            return [TreatmentSaleDraft.model_validate(row) for row in payload]
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
            payload: object = json_module.loads(response.content, parse_float=Decimal)
            return payload
        except httpx.HTTPStatusError as error:
            try:
                failure = json_module.loads(error.response.content, parse_float=Decimal)
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
