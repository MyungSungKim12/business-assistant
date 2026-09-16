from typing import Any
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import RepositoryUnavailableError, TaskSummary


class _TaskRow(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    organization_id: UUID
    created_by: UUID
    title: str
    description: str
    due_at: str | None
    status: str
    priority: str


class SupabaseTaskRepository:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = f"{supabase_url.rstrip('/')}/rest/v1/tasks"
        self._key = publishable_key
        self._token = access_token
        self._client = client

    async def list_tasks(self, organization_id: UUID, task_status: str | None) -> list[TaskSummary]:
        params = {
            "select": "id,organization_id,created_by,title,description,due_at,status,priority",
            "organization_id": f"eq.{organization_id}",
        }
        if task_status:
            params["status"] = f"eq.{task_status}"
        return self._summaries(await self._request("GET", params=params))

    async def create_task(
        self, organization_id: UUID, created_by: UUID, values: dict[str, str | None]
    ) -> TaskSummary:
        rows = await self._request(
            "POST",
            json={**values, "organization_id": str(organization_id), "created_by": str(created_by)},
            headers={"Prefer": "return=representation"},
        )
        return self._summaries(rows)[0]

    async def update_task(
        self, organization_id: UUID, task_id: UUID, user_id: UUID, values: dict[str, str | None]
    ) -> TaskSummary | None:
        del user_id
        rows = await self._request(
            "PATCH",
            params={"id": f"eq.{task_id}", "organization_id": f"eq.{organization_id}"},
            json=values,
            headers={"Prefer": "return=representation"},
        )
        return self._summaries(rows)[0] if rows else None

    async def delete_task(self, organization_id: UUID, task_id: UUID, user_id: UUID) -> bool:
        del user_id
        return bool(
            await self._request(
                "DELETE",
                params={"id": f"eq.{task_id}", "organization_id": f"eq.{organization_id}"},
                headers={"Prefer": "return=representation"},
            )
        )

    async def _request(
        self,
        method: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str | None] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        try:
            request_headers = {
                "apikey": self._key,
                "Authorization": f"Bearer {self._token}",
                **(headers or {}),
            }
            if self._client:
                response = await self._client.request(
                    method, self._url, params=params, json=json, headers=request_headers
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method, self._url, params=params, json=json, headers=request_headers
                    )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _summaries(rows: list[dict[str, Any]]) -> list[TaskSummary]:
        try:
            return [
                TaskSummary(
                    row.id,
                    row.organization_id,
                    row.created_by,
                    row.title,
                    row.description,
                    row.due_at,
                    row.status,
                    row.priority,
                )
                for row in (_TaskRow.model_validate(item) for item in rows)
            ]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
