from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator

from business_assistant_server.api.customers import require_customer_management_role
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    CustomerActivityRepository,
    CustomerActivitySummary,
    RepositoryUnavailableError,
)

router = APIRouter()


class ActivityCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    activity_type: str = "note"
    title: str
    description: str = ""
    occurred_at: str | None = None

    @field_validator("activity_type", "title")
    @classmethod
    def text_is_present(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 100:
            raise ValueError("value must be between 1 and 100 characters")
        return value

    @field_validator("description")
    @classmethod
    def description_is_bounded(cls, value: str) -> str:
        if len(value) > 10000:
            raise ValueError("description must be at most 10000 characters")
        return value


class ActivityResponseModel(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    activity_type: str
    title: str
    description: str
    occurred_at: str


def get_customer_activity_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> CustomerActivityRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401, detail="Not authenticated", headers={"WWW-Authenticate": "Bearer"}
        )
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(status_code=503, detail="Customer activity service unavailable")
    from business_assistant_server.adapters.supabase_customer_activities import (
        SupabaseCustomerActivityRepository,
    )

    return SupabaseCustomerActivityRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _response(item: CustomerActivitySummary) -> ActivityResponseModel:
    return ActivityResponseModel(
        id=item.id,
        organization_id=item.organization_id,
        customer_id=item.customer_id,
        activity_type=item.activity_type,
        title=item.title,
        description=item.description,
        occurred_at=item.occurred_at,
    )


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Customer activity service unavailable",
    )


@router.get(
    "/organizations/{organization_id}/customers/{customer_id}/activities",
    response_model=list[ActivityResponseModel],
)
async def list_activities(
    organization_id: UUID,
    customer_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[CustomerActivityRepository, Depends(get_customer_activity_repository)],
) -> list[ActivityResponseModel]:
    try:
        return [
            _response(item)
            for item in await repository.list_activities(organization_id, customer_id)
        ]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/activities",
    response_model=ActivityResponseModel,
    status_code=201,
)
async def create_activity(
    organization_id: UUID,
    customer_id: UUID,
    request: ActivityCreateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerActivityRepository, Depends(get_customer_activity_repository)],
) -> ActivityResponseModel:
    try:
        item = await repository.create_activity(
            organization_id,
            customer_id,
            request.activity_type,
            request.title,
            request.description,
            request.occurred_at,
        )
        return _response(item)
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.delete(
    "/organizations/{organization_id}/customers/{customer_id}/activities/{activity_id}",
    status_code=204,
)
async def delete_activity(
    organization_id: UUID,
    customer_id: UUID,
    activity_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerActivityRepository, Depends(get_customer_activity_repository)],
) -> None:
    try:
        if not await repository.delete_activity(organization_id, customer_id, activity_id):
            raise HTTPException(status_code=404, detail="Customer activity not found")
    except RepositoryUnavailableError:
        raise _unavailable() from None
