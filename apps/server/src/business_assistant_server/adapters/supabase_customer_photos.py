import logging
from typing import Any
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    CustomerPhotoRepository,
    CustomerPhotoSummary,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

logger = logging.getLogger(__name__)


class _Photo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    organization_id: UUID
    customer_id: UUID
    uploaded_by: UUID
    storage_path: str
    original_name: str
    content_type: str
    size_bytes: int
    caption: str
    created_at: str


class SupabaseCustomerPhotoRepository(CustomerPhotoRepository):
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

    async def list_photos(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[CustomerPhotoSummary]:
        rows = await self._request(
            "GET",
            "customer_photos",
            {
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "is_archived": "eq.false",
                "order": "created_at.desc",
            },
        )
        return [self._summary(self._parse(row)) for row in rows]

    async def create_photo(
        self, organization_id: UUID, customer_id: UUID, uploaded_by: UUID, values: dict[str, object]
    ) -> CustomerPhotoSummary:
        rows = await self._request(
            "POST",
            "customer_photos",
            json={
                "organization_id": str(organization_id),
                "customer_id": str(customer_id),
                "uploaded_by": str(uploaded_by),
                **values,
            },
            headers={"Prefer": "return=representation"},
        )
        if not rows:
            raise RepositoryUnavailableError()
        return self._summary(self._parse(rows[0]))

    async def get_photo(
        self, organization_id: UUID, customer_id: UUID, photo_id: UUID
    ) -> CustomerPhotoSummary | None:
        rows = await self._request(
            "GET",
            "customer_photos",
            {
                "id": f"eq.{photo_id}",
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
                "is_archived": "eq.false",
            },
        )
        return self._summary(self._parse(rows[0])) if rows else None

    async def archive_photo(
        self, organization_id: UUID, customer_id: UUID, photo_id: UUID
    ) -> CustomerPhotoSummary | None:
        rows = await self._request(
            "PATCH",
            "customer_photos",
            {
                "id": f"eq.{photo_id}",
                "organization_id": f"eq.{organization_id}",
                "customer_id": f"eq.{customer_id}",
            },
            json={"is_archived": True},
            headers={"Prefer": "return=representation"},
        )
        return self._summary(self._parse(rows[0])) if rows else None

    async def _request(
        self,
        method: str,
        table: str,
        params: dict[str, str] | None = None,
        *,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        try:
            if self._client is not None:
                response = await self._client.request(
                    method,
                    f"{self._base}/{table}",
                    params=params,
                    json=json,
                    headers={**self._headers, **(headers or {})},
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._base}/{table}",
                        params=params,
                        json=json,
                        headers={**self._headers, **(headers or {})},
                    )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            logger.warning(
                "Supabase customer photo request failed: status=%s table=%s body=%s",
                error.response.status_code,
                table,
                error.response.text[:500],
            )
            if error.response.status_code == 400:
                raise RepositoryValidationError() from error
            raise RepositoryUnavailableError() from error
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _parse(row: dict[str, Any]) -> _Photo:
        try:
            return _Photo.model_validate(row)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    @staticmethod
    def _summary(row: _Photo) -> CustomerPhotoSummary:
        return CustomerPhotoSummary(
            row.id,
            row.organization_id,
            row.customer_id,
            row.uploaded_by,
            row.storage_path,
            row.original_name,
            row.content_type,
            row.size_bytes,
            row.caption,
            row.created_at,
        )
