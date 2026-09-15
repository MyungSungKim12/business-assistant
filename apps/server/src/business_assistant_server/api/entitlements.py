from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel

from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.domain.entitlements import EntitlementService
from business_assistant_server.ports.repositories import (
    OrganizationRepository,
    RepositoryUnavailableError,
    SubscriptionSummary,
)

router = APIRouter()


class FeatureAccessDenied(Exception):
    def __init__(self, feature_code: str) -> None:
        self.feature_code = feature_code


class EntitlementResponseModel(BaseModel):
    organization_id: UUID
    plan_code: str | None
    features: list[str]


class SubscriptionResponseModel(BaseModel):
    organization_id: UUID
    plan_code: str
    status: str
    ends_at: datetime | None
    features: list[str]


def get_organization_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> OrganizationRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization service unavailable",
        )
    from business_assistant_server.adapters.supabase_organizations import (
        SupabaseOrganizationRepository,
    )

    return SupabaseOrganizationRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _http_error(error: Exception) -> HTTPException:
    if isinstance(error, LookupError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, PermissionError):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error))
    if isinstance(error, RepositoryUnavailableError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization service unavailable",
        )
    raise error


def _subscription_response(subscription: SubscriptionSummary) -> SubscriptionResponseModel:
    return SubscriptionResponseModel(
        organization_id=subscription.organization_id,
        plan_code=subscription.plan_code,
        status=subscription.status,
        ends_at=subscription.ends_at,
        features=subscription.features,
    )


@router.get(
    "/organizations/{organization_id}/entitlements", response_model=EntitlementResponseModel
)
async def get_entitlements(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> EntitlementResponseModel:
    try:
        entitlements = await EntitlementService(repository).get_active_entitlements(
            current_user.user_id, organization_id
        )
    except (LookupError, PermissionError, RepositoryUnavailableError) as error:
        raise _http_error(error) from None
    return EntitlementResponseModel(
        organization_id=entitlements.organization_id,
        plan_code=entitlements.plan_code,
        features=entitlements.features,
    )


@router.get(
    "/organizations/{organization_id}/subscriptions/current",
    response_model=SubscriptionResponseModel,
)
async def get_current_subscription(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> SubscriptionResponseModel:
    try:
        subscription = await EntitlementService(repository).get_current_subscription(
            current_user.user_id, organization_id
        )
    except (LookupError, PermissionError, RepositoryUnavailableError) as error:
        raise _http_error(error) from None
    return _subscription_response(subscription)


def require_feature(feature_code: str) -> Callable[..., Awaitable[None]]:
    async def check_feature(
        organization_id: UUID,
        current_user: Annotated[AuthUser, Depends(get_current_user)],
        repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    ) -> None:
        try:
            entitlements = await EntitlementService(repository).get_active_entitlements(
                current_user.user_id, organization_id
            )
        except (LookupError, PermissionError, RepositoryUnavailableError) as error:
            raise _http_error(error) from None
        if feature_code not in entitlements.features:
            raise FeatureAccessDenied(feature_code)

    return check_feature
