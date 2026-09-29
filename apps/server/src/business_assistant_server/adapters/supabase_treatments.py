from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
    TreatmentEventSummary,
    TreatmentPhotoSummary,
    TreatmentSummary,
)


class _Treatment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_date: str
    treatment_name: str
    category: str
    practitioner: str
    notes: str
    amount: Decimal | None = None
    next_visit_date: str | None = None
    status: str = "legacy"
    version: int = 1
    started_at: str | None = None
    ended_at: str | None = None
    consultation_goal: str = ""
    consultation_plan: str = ""
    cautions_snapshot: dict[str, object] = Field(default_factory=dict)
    cautions_acknowledged_by: UUID | None = None
    cautions_acknowledged_at: str | None = None


class _Event(BaseModel):
    id: UUID
    actor_id: UUID
    action: str
    reason: str
    occurred_at: str
    before_data: dict[str, object]
    after_data: dict[str, object]


class _Photo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_id: UUID
    storage_path: str
    thumbnail_path: str | None = None
    content_type: str
    caption: str
    sort_order: int
    taken_at: str | None = None


class SupabaseTreatmentRepository:
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

    async def list_treatments(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[TreatmentSummary]:
        rows = await self._request(
            "GET",
            "treatment_records",
            {
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "order": "treatment_date.desc",
            },
            select="id,organization_id,customer_id,treatment_date,treatment_name,category,practitioner,notes,amount,next_visit_date,status,version,started_at,ended_at,consultation_goal,consultation_plan,cautions_snapshot,cautions_acknowledged_by,cautions_acknowledged_at",
        )
        return [self._treatment(row) for row in rows]

    async def create_treatment(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> TreatmentSummary:
        payload = {
            "organization_id": str(organization_id),
            "customer_id": str(customer_id),
            **values,
        }
        rows = await self._request(
            "POST", "treatment_records", json=payload, headers={"Prefer": "return=representation"}
        )
        if not rows:
            raise RepositoryUnavailableError()
        return self._treatment(rows[0])

    async def update_treatment(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> TreatmentSummary | None:
        data = dict(values)
        expected_version = data.pop("expected_version", None)
        operation_id = data.pop("operation_id", None) or str(uuid4())
        if expected_version is None:
            raise RepositoryConflictError()
        return await self.mutate_treatment(
            organization_id,
            customer_id,
            treatment_id,
            {
                "action": "edit",
                "expected_version": expected_version,
                "operation_id": operation_id,
                "reason": "",
                "values": data,
            },
        )

    async def mutate_treatment(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> TreatmentSummary:
        payload = {
            "p_organization_id": str(organization_id),
            "p_customer_id": str(customer_id),
            "p_treatment_id": str(treatment_id),
            **{f"p_{key}": value for key, value in values.items()},
        }
        payload["p_values"] = values.get("values") or {}
        rows = await self._request("POST", "rpc/mutate_treatment", json=payload)
        if not rows:
            raise RepositoryNotFoundError()
        return self._treatment(rows[0])

    async def list_treatment_events(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID
    ) -> list[TreatmentEventSummary]:
        rows = await self._request(
            "GET",
            "treatment_record_events",
            {
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "treatment_id": f"eq.{treatment_id}",
                "order": "occurred_at.desc,id.desc",
            },
            select="id,actor_id,action,reason,occurred_at,before_data,after_data",
        )
        try:
            return [
                TreatmentEventSummary(**_Event.model_validate(row).model_dump()) for row in rows
            ]
        except ValidationError as exc:
            raise RepositoryUnavailableError() from exc

    async def list_photos(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID | None = None
    ) -> list[TreatmentPhotoSummary]:
        params = {
            "organization_id": f"eq.{organization_id}",
            "customer_id": f"eq.{customer_id}",
            "order": "sort_order.asc,created_at.asc",
        }
        if treatment_id is not None:
            params["treatment_id"] = f"eq.{treatment_id}"
        rows = await self._request(
            "GET",
            "treatment_photos",
            params,
            select="id,organization_id,customer_id,treatment_id,storage_path,thumbnail_path,content_type,caption,sort_order,taken_at",
        )
        return [self._photo(row) for row in rows]

    async def create_photo(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> TreatmentPhotoSummary:
        payload = {
            "organization_id": str(organization_id),
            "customer_id": str(customer_id),
            **values,
        }
        rows = await self._request(
            "POST", "treatment_photos", json=payload, headers={"Prefer": "return=representation"}
        )
        return self._photo(rows[0])

    async def delete_photo(self, organization_id: UUID, customer_id: UUID, photo_id: UUID) -> bool:
        rows = await self._request(
            "DELETE",
            "treatment_photos",
            {
                "id": f"eq.{photo_id}",
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
            },
            headers={"Prefer": "return=representation"},
        )
        return bool(rows)

    async def _request(
        self,
        method: str,
        table: str,
        params: dict[str, str] | None = None,
        *,
        select: str | None = None,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        query = dict(params or {})
        if select:
            query["select"] = select
        try:
            if self._client is not None:
                response = await self._client.request(
                    method,
                    f"{self._base}/{table}",
                    params=query,
                    json=json,
                    headers={**self._headers, **(headers or {})},
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._base}/{table}",
                        params=query,
                        json=json,
                        headers={**self._headers, **(headers or {})},
                    )
            if response.is_error:
                try:
                    detail = response.json()
                    code = detail.get("code") if isinstance(detail, dict) else None
                except ValueError:
                    code = None
                if code == "P0001":
                    raise RepositoryConflictError()
                if code == "P0002":
                    raise RepositoryNotFoundError()
                if code == "42501":
                    raise RepositoryPermissionError()
                if code in {"22023", "22007", "22008", "22P02", "23514", "22003"}:
                    raise RepositoryValidationError()
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _treatment(row: dict[str, Any]) -> TreatmentSummary:
        try:
            item = _Treatment.model_validate(row)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        return TreatmentSummary(
            item.id,
            item.organization_id,
            item.customer_id,
            item.treatment_date,
            item.treatment_name,
            item.category,
            item.practitioner,
            item.notes,
            item.amount,
            item.next_visit_date,
            item.status,
            item.version,
            item.started_at,
            item.ended_at,
            item.consultation_goal,
            item.consultation_plan,
            item.cautions_snapshot,
            item.cautions_acknowledged_by,
            item.cautions_acknowledged_at,
        )

    @staticmethod
    def _photo(row: dict[str, Any]) -> TreatmentPhotoSummary:
        try:
            item = _Photo.model_validate(row)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        return TreatmentPhotoSummary(
            item.id,
            item.organization_id,
            item.customer_id,
            item.treatment_id,
            item.storage_path,
            item.thumbnail_path,
            item.content_type,
            item.caption,
            item.sort_order,
            item.taken_at,
        )
