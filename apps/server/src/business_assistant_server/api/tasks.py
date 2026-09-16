from datetime import datetime
from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    RepositoryUnavailableError,
    TaskRepository,
    TaskSummary,
)

router = APIRouter()
_STATUSES = {"open", "in_progress", "done", "canceled"}
_PRIORITIES = {"low", "normal", "high"}


class TaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    description: str = ""
    due_at: datetime | None = None
    status: str = "open"
    priority: str = "normal"

    @field_validator("title")
    @classmethod
    def valid_title(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("title must be between 1 and 200 characters")
        return value

    @field_validator("status")
    @classmethod
    def valid_status(cls, value: str) -> str:
        if value not in _STATUSES:
            raise ValueError("invalid task status")
        return value

    @field_validator("priority")
    @classmethod
    def valid_priority(cls, value: str) -> str:
        if value not in _PRIORITIES:
            raise ValueError("invalid task priority")
        return value

    @field_validator("due_at")
    @classmethod
    def valid_due_at(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("due_at must be timezone-aware")
        return value


class TaskUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = None
    description: str | None = None
    due_at: datetime | None = None
    status: str | None = None
    priority: str | None = None

    @field_validator("title")
    @classmethod
    def valid_title(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("title must not be null")
        return TaskCreateRequest.valid_title(value)

    @field_validator("status")
    @classmethod
    def valid_status(cls, value: str | None) -> str | None:
        if value is not None and value not in _STATUSES:
            raise ValueError("invalid task status")
        return value

    @field_validator("priority")
    @classmethod
    def valid_priority(cls, value: str | None) -> str | None:
        if value is not None and value not in _PRIORITIES:
            raise ValueError("invalid task priority")
        return value

    @field_validator("description")
    @classmethod
    def valid_description(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("description must not be null")
        return value

    @field_validator("due_at")
    @classmethod
    def valid_due_at(cls, value: datetime | None) -> datetime | None:
        return TaskCreateRequest.valid_due_at(value)

    @model_validator(mode="after")
    def nonempty(self) -> "TaskUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("at least one task field is required")
        return self


class TaskResponse(BaseModel):
    id: UUID
    organization_id: UUID
    created_by: UUID
    title: str
    description: str
    due_at: str | None
    status: str
    priority: str


def get_task_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> TaskRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Task service unavailable")
    from business_assistant_server.adapters.supabase_tasks import SupabaseTaskRepository

    return SupabaseTaskRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _response(task: TaskSummary) -> TaskResponse:
    return (
        TaskResponse(**task.__dict__)
        if hasattr(task, "__dict__")
        else TaskResponse(
            id=task.id,
            organization_id=task.organization_id,
            created_by=task.created_by,
            title=task.title,
            description=task.description,
            due_at=task.due_at,
            status=task.status,
            priority=task.priority,
        )
    )


def _unavailable() -> HTTPException:
    return HTTPException(503, "Task service unavailable")


@router.get("/organizations/{organization_id}/tasks", response_model=list[TaskResponse])
async def list_tasks(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("task.basic"))],
    repository: Annotated[TaskRepository, Depends(get_task_repository)],
    status: str | None = None,
) -> list[TaskResponse]:
    if status is not None and status not in _STATUSES:
        raise HTTPException(422, "Invalid task status")
    try:
        return [_response(item) for item in await repository.list_tasks(organization_id, status)]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post("/organizations/{organization_id}/tasks", response_model=TaskResponse, status_code=201)
async def create_task(
    organization_id: UUID,
    request: TaskCreateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("task.basic"))],
    repository: Annotated[TaskRepository, Depends(get_task_repository)],
) -> TaskResponse:
    try:
        return _response(
            await repository.create_task(
                organization_id, current_user.user_id, request.model_dump(mode="json")
            )
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.patch("/organizations/{organization_id}/tasks/{task_id}", response_model=TaskResponse)
async def update_task(
    organization_id: UUID,
    task_id: UUID,
    request: TaskUpdateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("task.basic"))],
    repository: Annotated[TaskRepository, Depends(get_task_repository)],
) -> TaskResponse:
    try:
        task = await repository.update_task(
            organization_id,
            task_id,
            current_user.user_id,
            request.model_dump(exclude_unset=True, mode="json"),
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if task is None:
        raise HTTPException(404, "Task not found")
    return _response(task)


@router.delete("/organizations/{organization_id}/tasks/{task_id}", status_code=204)
async def delete_task(
    organization_id: UUID,
    task_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("task.basic"))],
    repository: Annotated[TaskRepository, Depends(get_task_repository)],
) -> None:
    try:
        deleted = await repository.delete_task(organization_id, task_id, current_user.user_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if not deleted:
        raise HTTPException(404, "Task not found")
