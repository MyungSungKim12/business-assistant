"""PostgREST and Storage adapter for organization-scoped files."""

from typing import Any
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    FileRepository,
    FileSummary,
    RepositoryUnavailableError,
    RepositoryValidationError,
)
from business_assistant_server.ports.storage import StoragePort


class _FileRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    organization_id: UUID
    uploaded_by: UUID
    storage_path: str
    original_name: str
    content_type: str
    size_bytes: int
    is_archived: bool
    created_at: str
    updated_at: str


class SupabaseFileRepository(FileRepository):
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._rest_url = f"{supabase_url.rstrip('/')}/rest/v1"
        self._key = publishable_key
        self._token = access_token
        self._client = client

    async def list_files(
        self, organization_id: UUID, include_archived: bool = False
    ) -> list[FileSummary]:
        params: dict[str, str] = {
            "organization_id": f"eq.{organization_id}",
            "order": "created_at.desc",
        }
        if not include_archived:
            params["is_archived"] = "eq.false"
        rows = await self._request("GET", "file_assets", params=params)
        return [self._summary(self._parse(row)) for row in rows]

    async def create_file(
        self, organization_id: UUID, uploaded_by: UUID, values: dict[str, object]
    ) -> FileSummary:
        rows = await self._request(
            "POST",
            "file_assets",
            json={
                **values,
                "organization_id": str(organization_id),
                "uploaded_by": str(uploaded_by),
            },
            headers={"Prefer": "return=representation"},
        )
        if not rows:
            raise RepositoryUnavailableError()
        return self._summary(self._parse(rows[0]))

    async def get_file(self, organization_id: UUID, file_id: UUID) -> FileSummary | None:
        rows = await self._request(
            "GET",
            "file_assets",
            params={"id": f"eq.{file_id}", "organization_id": f"eq.{organization_id}"},
        )
        return self._summary(self._parse(rows[0])) if rows else None

    async def archive_file(self, organization_id: UUID, file_id: UUID) -> FileSummary | None:
        rows = await self._request(
            "PATCH",
            "file_assets",
            params={"id": f"eq.{file_id}", "organization_id": f"eq.{organization_id}"},
            json={"is_archived": True},
            headers={"Prefer": "return=representation"},
        )
        return self._summary(self._parse(rows[0])) if rows else None

    async def _request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        request_headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._token}",
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
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 400:
                raise RepositoryValidationError() from error
            raise RepositoryUnavailableError() from error
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _parse(row: dict[str, Any]) -> _FileRow:
        try:
            return _FileRow.model_validate(row)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    @staticmethod
    def _summary(row: _FileRow) -> FileSummary:
        return FileSummary(
            row.id,
            row.organization_id,
            row.uploaded_by,
            row.original_name,
            row.content_type,
            row.size_bytes,
            row.is_archived,
            row.created_at,
            row.updated_at,
            row.storage_path,
        )


class SupabaseStorageAdapter(StoragePort):
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = f"{supabase_url.rstrip('/')}/storage/v1"
        self._headers = {"apikey": publishable_key, "Authorization": f"Bearer {access_token}"}
        self._client = client

    async def _post(self, path: str, payload: dict[str, object]) -> str:
        try:
            if self._client is not None:
                response = await self._client.post(
                    f"{self._url}/{path}", json=payload, headers=self._headers
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        f"{self._url}/{path}", json=payload, headers=self._headers
                    )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        signed = body.get("signedURL") or body.get("signedUrl")
        if not isinstance(signed, str):
            raise RepositoryUnavailableError()
        return signed if signed.startswith("http") else f"{self._url}{signed}"

    async def create_upload_url(self, bucket: str, object_path: str) -> str:
        return await self._post(f"object/upload/sign/{bucket}/{object_path}", {})

    async def create_download_url(self, bucket: str, object_path: str, expires_in: int) -> str:
        return await self._post(f"object/sign/{bucket}/{object_path}", {"expiresIn": expires_in})
