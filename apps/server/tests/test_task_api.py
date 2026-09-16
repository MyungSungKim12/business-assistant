import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from business_assistant_common.auth import AuthUser
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.tasks import get_task_repository
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import SubscriptionSummary, TaskSummary

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
OUTSIDER_ID = UUID("87654321-4321-8765-4321-876543218765")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_ORGANIZATION_ID = UUID("22222222-2222-2222-2222-222222222222")
TASK_ID = UUID("33333333-3333-3333-3333-333333333333")


class FakeAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token == "owner-token":
            return AuthUser(OWNER_ID, "owner@example.com", "Owner")
        if access_token == "outsider-token":
            return AuthUser(OUTSIDER_ID, "outsider@example.com", "Outsider")
        raise AuthenticationError()


class FakeOrganizationRepository:
    def __init__(self, features: list[str] | None = None) -> None:
        self.features = ["task.basic"] if features is None else features

    async def organization_exists(self, organization_id: UUID) -> bool:
        return organization_id == ORGANIZATION_ID

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        return "owner" if (user_id, organization_id) == (OWNER_ID, ORGANIZATION_ID) else None

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        del now
        return SubscriptionSummary(
            organization_id, "BASIC", "active", datetime.now(UTC) + timedelta(days=1), self.features
        )


class FakeTaskRepository:
    def __init__(self) -> None:
        self.tasks = {
            TASK_ID: TaskSummary(
                TASK_ID,
                ORGANIZATION_ID,
                OWNER_ID,
                "Prepare proposal",
                "Draft",
                None,
                "open",
                "normal",
            )
        }

    async def list_tasks(self, organization_id: UUID, task_status: str | None) -> list[TaskSummary]:
        return [
            task
            for task in self.tasks.values()
            if task.organization_id == organization_id
            and (task_status is None or task.status == task_status)
        ]

    async def create_task(
        self, organization_id: UUID, created_by: UUID, values: dict[str, str | None]
    ) -> TaskSummary:
        task = TaskSummary(
            uuid4(),
            organization_id,
            created_by,
            values["title"] or "",
            values.get("description") or "",
            values.get("due_at"),
            values.get("status") or "open",
            values.get("priority") or "normal",
        )
        self.tasks[task.id] = task
        return task

    async def update_task(
        self, organization_id: UUID, task_id: UUID, user_id: UUID, values: dict[str, str | None]
    ) -> TaskSummary | None:
        task = self.tasks.get(task_id)
        if task is None or task.organization_id != organization_id:
            return None
        updated = TaskSummary(
            task.id,
            task.organization_id,
            task.created_by,
            values.get("title", task.title) or task.title,
            values.get("description", task.description) or "",
            values.get("due_at", task.due_at),
            values.get("status", task.status) or task.status,
            values.get("priority", task.priority) or task.priority,
        )
        self.tasks[task_id] = updated
        return updated

    async def delete_task(self, organization_id: UUID, task_id: UUID, user_id: UUID) -> bool:
        task = self.tasks.get(task_id)
        if task is None or task.organization_id != organization_id:
            return False
        del self.tasks[task_id]
        return True


class UnavailableTaskRepository(FakeTaskRepository):
    async def list_tasks(self, organization_id: UUID, task_status: str | None) -> list[TaskSummary]:
        from business_assistant_server.ports.repositories import RepositoryUnavailableError

        raise RepositoryUnavailableError()


def _request(
    method: str,
    path: str,
    *,
    organization_repository: FakeOrganizationRepository | None = None,
    task_repository: FakeTaskRepository | None = None,
    token: str | None = "owner-token",
    json: object = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: (
            organization_repository or FakeOrganizationRepository()
        )
        app.dependency_overrides[get_task_repository] = lambda: (
            task_repository or FakeTaskRepository()
        )
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            return await client.request(method, path, headers=headers, json=json)

    return asyncio.run(send())


def _path(organization_id: UUID = ORGANIZATION_ID) -> str:
    return f"/api/v1/organizations/{organization_id}/tasks"


def test_tasks_require_auth_membership_and_feature() -> None:
    assert _request("GET", _path(), token=None).status_code == 401
    assert _request("GET", _path(), token="outsider-token").status_code == 403
    assert (
        _request("GET", _path(), organization_repository=FakeOrganizationRepository([])).status_code
        == 403
    )


def test_task_crud_filter_validation_and_scoping() -> None:
    repository = FakeTaskRepository()
    assert (
        _request("POST", _path(), task_repository=repository, json={"title": None}).status_code
        == 422
    )
    assert (
        _request("POST", _path(), task_repository=repository, json={"title": ""}).status_code == 422
    )
    assert (
        _request(
            "POST", _path(), task_repository=repository, json={"title": "X", "status": "bad"}
        ).status_code
        == 422
    )
    created = _request(
        "POST",
        _path(),
        task_repository=repository,
        json={"title": " Call client ", "priority": "high", "due_at": "2030-01-01T00:00:00Z"},
    )
    assert created.status_code == 201
    assert created.json()["title"] == "Call client"
    task_id = UUID(created.json()["id"])
    assert len(_request("GET", f"{_path()}?status=open", task_repository=repository).json()) == 2
    updated = _request(
        "PATCH", f"{_path()}/{task_id}", task_repository=repository, json={"status": "done"}
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "done"
    assert (
        _request(
            "DELETE", f"{_path(OTHER_ORGANIZATION_ID)}/{task_id}", task_repository=repository
        ).status_code
        == 404
    )
    assert _request("DELETE", f"{_path()}/{task_id}", task_repository=repository).status_code == 204


def test_task_provider_error_is_safe() -> None:
    response = _request("GET", _path(), task_repository=UnavailableTaskRepository())
    assert response.status_code == 503
    assert response.json() == {"detail": "Task service unavailable"}
