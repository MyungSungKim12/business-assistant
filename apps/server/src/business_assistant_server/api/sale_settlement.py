"""Daily sales close and outstanding balance API."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from business_assistant_server.adapters.supabase_sale_settlement import (
    SaleDailySettlement,
    SupabaseSaleSettlementRepository,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.api.finance import (
    require_finance_management_role,
    require_finance_member,
)
from business_assistant_server.api.sale_carts import _safe_errors
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)

router = APIRouter(
    prefix="/organizations/{organization_id}/sale-daily-settlement",
    tags=["sales"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("finance.basic")),
        Depends(require_finance_member),
    ],
)
NonnegativeMoney = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,11})$")]


class CloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    counted_cash: NonnegativeMoney
    reason: Annotated[str, Field(min_length=1, max_length=1000)]
    confirmed: StrictBool

    @field_validator("reason")
    @classmethod
    def nonempty_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A close reason is required")
        return value

    @field_validator("confirmed")
    @classmethod
    def must_confirm(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Daily close confirmation is required")
        return value


class AdjustCloseRequest(CloseRequest):
    expected_version: Annotated[int, Field(ge=1, strict=True)]


def get_sale_settlement_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SupabaseSaleSettlementRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Daily settlement service unavailable")
    return SupabaseSaleSettlementRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


Repository = Annotated[SupabaseSaleSettlementRepository, Depends(get_sale_settlement_repository)]


@router.get("", response_model=SaleDailySettlement)
async def get_daily_settlement(
    organization_id: UUID,
    business_date: date,
    repository: Repository,
) -> SaleDailySettlement:
    with _safe_errors():
        return await repository.get_daily_settlement(organization_id, business_date)


@router.post("/close", response_model=SaleDailySettlement)
async def close_day(
    organization_id: UUID,
    business_date: date,
    request: CloseRequest,
    repository: Repository,
    _: Annotated[None, Depends(require_finance_management_role)],
) -> SaleDailySettlement:
    with _safe_errors():
        return await repository.close_day(
            organization_id,
            business_date,
            request.counted_cash,
            request.reason,
            request.operation_id,
            request.confirmed,
        )


@router.post("/adjustments", response_model=SaleDailySettlement)
async def adjust_close(
    organization_id: UUID,
    business_date: date,
    request: AdjustCloseRequest,
    repository: Repository,
    _: Annotated[None, Depends(require_finance_management_role)],
) -> SaleDailySettlement:
    with _safe_errors():
        return await repository.adjust_close(
            organization_id,
            business_date,
            request.expected_version,
            request.counted_cash,
            request.reason,
            request.operation_id,
            request.confirmed,
        )
