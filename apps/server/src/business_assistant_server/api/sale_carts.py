"""Visit sale cart API. Carts are review-only and never record payment."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from business_assistant_server.adapters.supabase_sale_carts import (
    CustomerVisit,
    SaleCartBundle,
    SaleCartRepository,
    SupabaseSaleCartRepository,
)
from business_assistant_server.adapters.supabase_treatment_sale_drafts import (
    TreatmentSaleDraft,
    TreatmentSaleDraftRepository,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.api.finance import (
    require_finance_management_role,
    require_finance_member,
)
from business_assistant_server.api.treatment_sale_drafts import get_treatment_sale_draft_repository
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

router = APIRouter(
    prefix="/organizations/{organization_id}",
    tags=["sale-carts"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("finance.basic")),
        Depends(require_finance_member),
    ],
)
MoneyText = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$")]


class OperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID


class VersionedOperationRequest(OperationRequest):
    expected_version: Annotated[int, Field(ge=1, strict=True)]


class AddTreatmentDraftRequest(VersionedOperationRequest):
    draft_id: UUID


class UpdateLineRequest(VersionedOperationRequest):
    quantity: Annotated[int, Field(ge=1, le=999, strict=True)] | None = None
    unit_price: MoneyText | None = None
    staff_id: UUID | None = None
    staff_name: Annotated[str, Field(max_length=200)] | None = None

    @field_validator("quantity", "unit_price", "staff_name", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("Explicit null is not a line value")
        return value


class RemoveLineRequest(VersionedOperationRequest):
    reason: Annotated[str, Field(min_length=1, max_length=1000)]

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Removal reason is required")
        return value.strip()


class ReviewCartRequest(VersionedOperationRequest):
    ready: StrictBool


def get_sale_cart_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SaleCartRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Sale cart service unavailable")
    return SupabaseSaleCartRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


@contextmanager
def _safe_errors() -> Iterator[None]:
    try:
        yield
    except RepositoryConflictError:
        raise HTTPException(409, "Sale cart conflict; reload before retrying") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Visit, cart, line, customer or draft not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Sale cart access permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid sale cart request") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Sale cart service unavailable") from None


@router.get("/visits", response_model=list[CustomerVisit])
async def list_visits(
    organization_id: UUID,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
    customer_id: UUID | None = None,
    status: Annotated[str | None, Query(pattern="^(open|checkout_ready|closed|canceled)$")] = None,
) -> list[CustomerVisit]:
    with _safe_errors():
        return await repository.list_visits(organization_id, customer_id, status)


@router.get("/sale-cart-drafts", response_model=list[TreatmentSaleDraft])
async def list_cart_drafts(
    organization_id: UUID,
    repository: Annotated[
        TreatmentSaleDraftRepository, Depends(get_treatment_sale_draft_repository)
    ],
) -> list[TreatmentSaleDraft]:
    """Read existing charge snapshots with CRM/finance access, without document editing."""
    with _safe_errors():
        return await repository.list_drafts(organization_id)


@router.post(
    "/customers/{customer_id}/visits",
    response_model=SaleCartBundle,
    status_code=201,
    dependencies=[Depends(require_finance_management_role)],
)
async def create_visit(
    organization_id: UUID,
    customer_id: UUID,
    request: OperationRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.create_visit(organization_id, customer_id, request.operation_id)


@router.get("/visits/{visit_id}/sale-cart", response_model=SaleCartBundle)
async def get_sale_cart(
    organization_id: UUID,
    visit_id: UUID,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.get_cart(organization_id, visit_id)


@router.post(
    "/visits/{visit_id}/sale-cart/lines/treatment-draft",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def add_treatment_draft(
    organization_id: UUID,
    visit_id: UUID,
    request: AddTreatmentDraftRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.add_treatment_draft(
            organization_id,
            visit_id,
            request.draft_id,
            request.expected_version,
            request.operation_id,
        )


@router.patch(
    "/visits/{visit_id}/sale-cart/lines/{line_id}",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def update_line(
    organization_id: UUID,
    visit_id: UUID,
    line_id: UUID,
    request: UpdateLineRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    values = request.model_dump(
        mode="json", exclude={"expected_version", "operation_id"}, exclude_unset=True
    )
    if not values:
        raise HTTPException(422, "At least one line value is required")
    with _safe_errors():
        return await repository.mutate_line(
            organization_id,
            visit_id,
            line_id,
            request.expected_version,
            request.operation_id,
            "update",
            values,
        )


@router.post(
    "/visits/{visit_id}/sale-cart/lines/{line_id}/remove",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def remove_line(
    organization_id: UUID,
    visit_id: UUID,
    line_id: UUID,
    request: RemoveLineRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.mutate_line(
            organization_id,
            visit_id,
            line_id,
            request.expected_version,
            request.operation_id,
            "remove",
            {"reason": request.reason},
        )


@router.post(
    "/visits/{visit_id}/sale-cart/lines/{line_id}/restore",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def restore_line(
    organization_id: UUID,
    visit_id: UUID,
    line_id: UUID,
    request: VersionedOperationRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.mutate_line(
            organization_id,
            visit_id,
            line_id,
            request.expected_version,
            request.operation_id,
            "restore",
            {},
        )


@router.post(
    "/visits/{visit_id}/sale-cart/review",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def review_cart(
    organization_id: UUID,
    visit_id: UUID,
    request: ReviewCartRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.review(
            organization_id,
            visit_id,
            request.expected_version,
            request.operation_id,
            request.ready,
        )


@router.post(
    "/visits/{visit_id}/cancel",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def cancel_visit(
    organization_id: UUID,
    visit_id: UUID,
    request: VersionedOperationRequest,
    repository: Annotated[SaleCartRepository, Depends(get_sale_cart_repository)],
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.cancel_visit(
            organization_id, visit_id, request.expected_version, request.operation_id
        )
