from typing import Any, TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    CustomerSummary,
    RepositoryUnavailableError,
)

ModelT = TypeVar("ModelT", bound=BaseModel)


class _CustomerRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    organization_id: UUID
    name: str
    email: str | None
    phone: str | None
    notes: str


class SupabaseCustomerRepository:
    """PostgREST customer adapter using only the current user's access token."""

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

    async def list_customers(self, organization_id: UUID) -> list[CustomerSummary]:
        rows = await self._request_rows(
            "GET",
            params={
                "select": "id,organization_id,name,email,phone,notes",
                "organization_id": f"eq.{organization_id}",
            },
        )
        return [self._to_summary(row) for row in self._parse_rows(rows, _CustomerRow)]

    async def create_customer(
        self,
        organization_id: UUID,
        name: str,
        email: str | None,
        phone: str | None,
        notes: str,
    ) -> CustomerSummary:
        rows = await self._request_rows(
            "POST",
            json={
                "organization_id": str(organization_id),
                "name": name,
                "email": email,
                "phone": phone,
                "notes": notes,
            },
            headers={"Prefer": "return=representation"},
        )
        return self._to_summary(self._parse_one(rows, _CustomerRow))

    async def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> CustomerSummary | None:
        rows = await self._request_rows(
            "PATCH",
            params={"id": f"eq.{customer_id}", "organization_id": f"eq.{organization_id}"},
            json=values,
            headers={"Prefer": "return=representation"},
        )
        if not rows:
            return None
        return self._to_summary(self._parse_one(rows, _CustomerRow))

    async def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool:
        rows = await self._request_rows(
            "DELETE",
            params={"id": f"eq.{customer_id}", "organization_id": f"eq.{organization_id}"},
            headers={"Prefer": "return=representation"},
        )
        return bool(rows)

    async def _request_rows(
        self,
        method: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str | None] | None = None,
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
                    f"{self._rest_url}/customers",
                    params=params,
                    json=json,
                    headers=request_headers,
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._rest_url}/customers",
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
    def _to_summary(row: _CustomerRow) -> CustomerSummary:
        return CustomerSummary(
            row.id, row.organization_id, row.name, row.email, row.phone, row.notes
        )
