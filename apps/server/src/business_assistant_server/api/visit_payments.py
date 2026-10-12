"""Organization-scoped recording of receipts confirmed outside the application."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from business_assistant_server.adapters.supabase_visit_payments import (
    SupabaseVisitPaymentRepository,
    VisitPayments,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.api.finance import (
    require_finance_management_role,
    require_finance_member,
)
from business_assistant_server.api.sale_carts import VersionedOperationRequest, _safe_errors
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)

router = APIRouter(
    prefix="/organizations/{organization_id}/visits/{visit_id}/payments",
    tags=["visit-payments"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("finance.basic")),
        Depends(require_finance_member),
    ],
)


class PaymentPart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: Literal["cash", "card", "transfer"]
    amount: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,11}$")]
    reference: Annotated[str, Field(max_length=200)] = ""

    @model_validator(mode="after")
    def reference_required(self) -> "PaymentPart":
        self.reference = self.reference.strip()
        if self.method != "cash" and not self.reference:
            raise ValueError("Card/transfer reference is required")
        return self


class RecordPaymentRequest(VersionedOperationRequest):
    payments: Annotated[list[PaymentPart], Field(min_length=1, max_length=3)]
    confirmed: StrictBool

    @model_validator(mode="after")
    def must_confirm(self) -> "RecordPaymentRequest":
        if not self.confirmed:
            raise ValueError("Receipt confirmation is required")
        if len({part.method for part in self.payments}) != len(self.payments):
            raise ValueError("Duplicate payment methods")
        return self


class RefundPaymentRequest(VersionedOperationRequest):
    source_id: UUID
    amount: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,11}$")]
    reason: Annotated[str, Field(min_length=1, max_length=1000)]
    confirmed: StrictBool

    @model_validator(mode="after")
    def confirm_and_strip(self) -> "RefundPaymentRequest":
        self.reason = self.reason.strip()
        if not self.confirmed or not self.reason:
            raise ValueError("Refund confirmation and reason are required")
        return self


class ProductReturnRequest(VersionedOperationRequest):
    sale_line_id: UUID
    receipt_id: UUID
    quantity: Annotated[int, Field(ge=1, le=999, strict=True)]
    restock: StrictBool
    amount: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,11}$")]
    reason: Annotated[str, Field(min_length=1, max_length=1000)]
    confirmed: StrictBool

    @model_validator(mode="after")
    def confirm_and_strip(self) -> "ProductReturnRequest":
        self.reason = self.reason.strip()
        if not self.confirmed or not self.reason:
            raise ValueError("Product return confirmation and reason are required")
        return self


def get_visit_payment_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SupabaseVisitPaymentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Payment service unavailable")
    return SupabaseVisitPaymentRepository(
        str(settings.supabase_url),
        settings.supabase_publishable_key,
        authorization.credentials,
    )


@router.get("", response_model=VisitPayments)
async def get_payments(
    organization_id: UUID,
    visit_id: UUID,
    repository: Annotated[SupabaseVisitPaymentRepository, Depends(get_visit_payment_repository)],
) -> VisitPayments:
    with _safe_errors():
        return await repository.get_payments(organization_id, visit_id)


@router.post(
    "", response_model=VisitPayments, dependencies=[Depends(require_finance_management_role)]
)
async def record_payment(
    organization_id: UUID,
    visit_id: UUID,
    request: RecordPaymentRequest,
    repository: Annotated[SupabaseVisitPaymentRepository, Depends(get_visit_payment_repository)],
) -> VisitPayments:
    with _safe_errors():
        return await repository.record_payment(
            organization_id,
            visit_id,
            request.expected_version,
            request.operation_id,
            [part.model_dump(mode="json") for part in request.payments],
            request.confirmed,
        )


@router.post(
    "/refunds",
    response_model=VisitPayments,
    dependencies=[Depends(require_finance_management_role)],
)
async def refund_payment(
    organization_id: UUID,
    visit_id: UUID,
    request: RefundPaymentRequest,
    repository: Annotated[SupabaseVisitPaymentRepository, Depends(get_visit_payment_repository)],
) -> VisitPayments:
    with _safe_errors():
        return await repository.refund_payment(
            organization_id,
            visit_id,
            request.source_id,
            request.amount,
            request.reason,
            request.expected_version,
            request.operation_id,
            request.confirmed,
        )


@router.post(
    "/product-returns",
    response_model=VisitPayments,
    dependencies=[Depends(require_finance_management_role)],
)
async def return_product(
    organization_id: UUID,
    visit_id: UUID,
    request: ProductReturnRequest,
    repository: Annotated[SupabaseVisitPaymentRepository, Depends(get_visit_payment_repository)],
) -> VisitPayments:
    with _safe_errors():
        return await repository.return_product(
            organization_id,
            visit_id,
            request.sale_line_id,
            request.receipt_id,
            request.quantity,
            request.restock,
            request.amount,
            request.reason,
            request.expected_version,
            request.operation_id,
            request.confirmed,
        )
