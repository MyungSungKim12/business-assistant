from typing import Any
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    CustomerActivitySummary,
    RepositoryUnavailableError,
)


class _ActivityRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    organization_id: UUID
    customer_id: UUID
    activity_type: str
    title: str
    description: str
    occurred_at: str


class SupabaseCustomerActivityRepository:
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

    async def list_activities(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[CustomerActivitySummary]:
        rows = await self._request(
            "GET",
            params={
                "select": (
                    "id,organization_id,customer_id,activity_type,title,description,occurred_at"
                ),
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "order": "occurred_at.desc",
            },
        )
        return [self._summary(row) for row in self._parse(rows)]

    async def create_activity(
        self,
        organization_id: UUID,
        customer_id: UUID,
        activity_type: str,
        title: str,
        description: str,
        occurred_at: str | None,
    ) -> CustomerActivitySummary:
        values = {
            "organization_id": str(organization_id),
            "customer_id": str(customer_id),
            "activity_type": activity_type,
            "title": title,
            "description": description,
        }
        if occurred_at is not None:
            values["occurred_at"] = occurred_at
        rows = await self._request("POST", json=values, headers={"Prefer": "return=representation"})
        return self._summary(self._parse(rows)[0])

    async def delete_activity(
        self, organization_id: UUID, customer_id: UUID, activity_id: UUID
    ) -> bool:
        rows = await self._request(
            "DELETE",
            params={
                "id": f"eq.{activity_id}",
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
            },
            headers={"Prefer": "return=representation"},
        )
        return bool(rows)

    async def _request(
        self,
        method: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
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
                    f"{self._rest_url}/customer_activities",
                    params=params,
                    json=json,
                    headers=request_headers,
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._rest_url}/customer_activities",
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
    def _parse(rows: list[dict[str, Any]]) -> list[_ActivityRow]:
        try:
            return [_ActivityRow.model_validate(row) for row in rows]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    @staticmethod
    def _summary(row: _ActivityRow) -> CustomerActivitySummary:
        return CustomerActivitySummary(
            row.id,
            row.organization_id,
            row.customer_id,
            row.activity_type,
            row.title,
            row.description,
            row.occurred_at,
        )
