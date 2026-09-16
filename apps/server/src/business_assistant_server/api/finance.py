from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Query, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from business_assistant_server.api.entitlements import get_organization_repository, require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import bearer_scheme, get_current_user, get_settings
from business_assistant_server.ports.repositories import (
    FinanceRepository,
    FinanceSummary,
    FinanceTransactionSummary,
    OrganizationRepository,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

router = APIRouter()
_TRANSACTION_TYPES = {"income", "expense"}
_MONEY_LIMIT = Decimal("1000000000000")


def _valid_amount(value: Decimal) -> Decimal:
    if value <= 0 or value >= _MONEY_LIMIT or value.as_tuple().exponent < -2:
        raise ValueError("amount must be positive with at most 2 decimal places")
    return value


class FinanceTransactionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transaction_type: str
    amount: Decimal
    transaction_date: date
    category: str
    counterparty: str = ""
    memo: str = ""
    is_archived: bool = False

    @field_validator("transaction_type")
    @classmethod
    def valid_type(cls, value: str) -> str:
        if value not in _TRANSACTION_TYPES:
            raise ValueError("invalid transaction type")
        return value

    @field_validator("amount")
    @classmethod
    def valid_amount(cls, value: Decimal) -> Decimal:
        return _valid_amount(value)

    @field_validator("category")
    @classmethod
    def valid_category(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("category must be between 1 and 200 characters")
        return value

    @field_validator("counterparty", "memo")
    @classmethod
    def valid_text(cls, value: str) -> str:
        if len(value) > 5000:
            raise ValueError("text must be at most 5000 characters")
        return value


class FinanceTransactionUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transaction_type: str | None = None
    amount: Decimal | None = None
    transaction_date: date | None = None
    category: str | None = None
    counterparty: str | None = None
    memo: str | None = None
    is_archived: bool | None = None

    @field_validator("transaction_type")
    @classmethod
    def valid_type(cls, value: str | None) -> str:
        if value is None or value not in _TRANSACTION_TYPES:
            raise ValueError("invalid transaction type")
        return value

    @field_validator("amount")
    @classmethod
    def valid_amount(cls, value: Decimal | None) -> Decimal:
        if value is None:
            raise ValueError("amount must not be null")
        return _valid_amount(value)

    @field_validator("category")
    @classmethod
    def valid_category(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("category must not be null")
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("category must be between 1 and 200 characters")
        return value

    @field_validator("counterparty", "memo")
    @classmethod
    def valid_text(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("text must not be null")
        if len(value) > 5000:
            raise ValueError("text must be at most 5000 characters")
        return value

    @field_validator("is_archived")
    @classmethod
    def valid_archived(cls, value: bool | None) -> bool:
        if value is None:
            raise ValueError("is_archived must not be null")
        return value

    @model_validator(mode="after")
    def has_update(self) -> "FinanceTransactionUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("at least one transaction field is required")
        return self


class FinanceTransactionResponse(BaseModel):
    id: UUID
    organization_id: UUID
    created_by: UUID
    transaction_type: str
    amount: Decimal
    transaction_date: date
    category: str
    counterparty: str
    memo: str
    is_archived: bool
    created_at: str
    updated_at: str


class FinanceSummaryResponse(BaseModel):
    from_date: date | None
    to_date: date | None
    income_total: Decimal
    expense_total: Decimal
    net_total: Decimal
    transaction_count: int


def get_finance_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> FinanceRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Finance service unavailable")
    from business_assistant_server.adapters.supabase_finance import SupabaseFinanceRepository

    return SupabaseFinanceRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


async def require_finance_member(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    organization_repository: Annotated[
        OrganizationRepository, Depends(get_organization_repository)
    ],
) -> None:
    try:
        role = await organization_repository.get_membership(current_user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if role not in {"owner", "admin", "member"}:
        raise HTTPException(403, "Finance access permission required")


async def require_finance_management_role(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    organization_repository: Annotated[
        OrganizationRepository, Depends(get_organization_repository)
    ],
) -> None:
    try:
        role = await organization_repository.get_membership(current_user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if role not in {"owner", "admin"}:
        raise HTTPException(403, "Finance management permission required")


def _unavailable() -> HTTPException:
    return HTTPException(503, "Finance service unavailable")


def _response(item: FinanceTransactionSummary) -> FinanceTransactionResponse:
    return FinanceTransactionResponse(
        id=item.id,
        organization_id=item.organization_id,
        created_by=item.created_by,
        transaction_type=item.transaction_type,
        amount=item.amount,
        transaction_date=date.fromisoformat(item.transaction_date),
        category=item.category,
        counterparty=item.counterparty,
        memo=item.memo,
        is_archived=item.is_archived,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.get(
    "/organizations/{organization_id}/finance-transactions",
    response_model=list[FinanceTransactionResponse],
)
async def list_transactions(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("finance.basic"))],
    ___: Annotated[None, Depends(require_finance_member)],
    repository: Annotated[FinanceRepository, Depends(get_finance_repository)],
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    transaction_type: str | None = Query(default=None),
) -> list[FinanceTransactionResponse]:
    if from_date and to_date and from_date > to_date:
        raise HTTPException(422, "from_date must not be after to_date")
    if transaction_type is not None and transaction_type not in _TRANSACTION_TYPES:
        raise HTTPException(422, "Invalid transaction type")
    try:
        rows = await repository.list_transactions(
            organization_id, from_date, to_date, transaction_type
        )
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid finance request") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return [_response(item) for item in rows]


@router.post(
    "/organizations/{organization_id}/finance-transactions",
    response_model=FinanceTransactionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_transaction(
    organization_id: UUID,
    request: FinanceTransactionCreateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("finance.basic"))],
    __: Annotated[None, Depends(require_finance_management_role)],
    repository: Annotated[FinanceRepository, Depends(get_finance_repository)],
) -> FinanceTransactionResponse:
    try:
        item = await repository.create_transaction(
            organization_id, current_user.user_id, request.model_dump(mode="json")
        )
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid finance request") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return _response(item)


@router.patch(
    "/organizations/{organization_id}/finance-transactions/{transaction_id}",
    response_model=FinanceTransactionResponse,
)
async def update_transaction(
    organization_id: UUID,
    transaction_id: UUID,
    request: FinanceTransactionUpdateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("finance.basic"))],
    ___: Annotated[None, Depends(require_finance_management_role)],
    repository: Annotated[FinanceRepository, Depends(get_finance_repository)],
) -> FinanceTransactionResponse:
    try:
        item = await repository.update_transaction(
            organization_id,
            transaction_id,
            request.model_dump(exclude_unset=True, mode="json"),
        )
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid finance request") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if item is None:
        raise HTTPException(404, "Finance transaction not found")
    return _response(item)


@router.get(
    "/organizations/{organization_id}/finance-summary", response_model=FinanceSummaryResponse
)
async def finance_summary(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("finance.basic"))],
    ___: Annotated[None, Depends(require_finance_member)],
    repository: Annotated[FinanceRepository, Depends(get_finance_repository)],
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
) -> FinanceSummaryResponse:
    if from_date and to_date and from_date > to_date:
        raise HTTPException(422, "from_date must not be after to_date")
    try:
        summary: FinanceSummary = await repository.summarize_transactions(
            organization_id, from_date, to_date
        )
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid finance request") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return FinanceSummaryResponse(
        from_date=from_date,
        to_date=to_date,
        income_total=summary.income_total,
        expense_total=summary.expense_total,
        net_total=summary.net_total,
        transaction_count=summary.transaction_count,
    )
