"""Management preview, deliberately separate from confirmed accounting profit."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials

from business_assistant_server.adapters.supabase_management import (
    ManagementPreview,
    SupabaseManagementRepository,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.api.finance import require_finance_management_role
from business_assistant_server.api.sale_carts import _safe_errors
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)

router = APIRouter(
    prefix="/organizations/{organization_id}/management-preview",
    tags=["management"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("finance.basic")),
        Depends(require_finance_management_role),
    ],
)


def get_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SupabaseManagementRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Management service unavailable")
    return SupabaseManagementRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


@router.get("", response_model=ManagementPreview)
async def get_management_preview(
    organization_id: UUID,
    from_date: date,
    to_date: date,
    repository: Annotated[SupabaseManagementRepository, Depends(get_repository)],
) -> ManagementPreview:
    if to_date < from_date or (to_date - from_date).days > 366:
        raise HTTPException(422, "Invalid report period")
    with _safe_errors():
        return await repository.get_preview(organization_id, from_date, to_date)
