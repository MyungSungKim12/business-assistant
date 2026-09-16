from datetime import datetime
from typing import Annotated, Protocol
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator, model_validator

from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import get_current_user, get_settings

router = APIRouter()


class AdminSubscriptionInputError(Exception):
    pass


class AdminSubscriptionUnavailableError(Exception):
    pass


class AdminSubscriptionNotFoundError(Exception):
    pass


class AdminSubscriptionRequest(BaseModel):
    plan_code: str
    status: str
    starts_at: datetime
    ends_at: datetime | None

    @field_validator("plan_code")
    @classmethod
    def plan_code_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("plan_code is required")
        return value.strip().upper()

    @field_validator("status")
    @classmethod
    def status_is_supported(cls, value: str) -> str:
        if value not in {"trialing", "active", "past_due", "canceled", "expired"}:
            raise ValueError("unsupported subscription status")
        return value

    @model_validator(mode="after")
    def window_is_valid(self) -> "AdminSubscriptionRequest":
        if self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        return self


class AdminSubscriptionRepository(Protocol):
    async def replace_subscription(
        self, organization_id: UUID, request: AdminSubscriptionRequest
    ) -> AdminSubscriptionRequest: ...


def get_admin_subscription_repository(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AdminSubscriptionRepository:
    if settings.supabase_url is None or settings.supabase_service_key is None:
        raise HTTPException(status_code=503, detail="Admin subscription service unavailable")
    from business_assistant_server.adapters.supabase_admin_subscriptions import (
        SupabaseAdminSubscriptionRepository,
    )

    return SupabaseAdminSubscriptionRepository(
        str(settings.supabase_url), settings.supabase_service_key
    )


@router.post(
    "/admin/organizations/{organization_id}/subscription", response_model=AdminSubscriptionRequest
)
async def replace_subscription(
    organization_id: UUID,
    request: AdminSubscriptionRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    repository: Annotated[AdminSubscriptionRepository, Depends(get_admin_subscription_repository)],
) -> AdminSubscriptionRequest:
    if current_user.user_id not in settings.platform_admin_user_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Platform admin required")
    try:
        return await repository.replace_subscription(organization_id, request)
    except AdminSubscriptionInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except AdminSubscriptionNotFoundError:
        raise HTTPException(status_code=404, detail="Organization not found") from None
    except AdminSubscriptionUnavailableError:
        raise HTTPException(
            status_code=503, detail="Admin subscription service unavailable"
        ) from None
