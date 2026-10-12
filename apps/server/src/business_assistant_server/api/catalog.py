"""Sale products, membership definitions, inventory receipts and customer wallets."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import Field, StrictBool, field_validator, model_validator

from business_assistant_server.adapters.supabase_catalog import (
    CatalogProduct,
    CatalogStockMovement,
    CustomerWallet,
    SupabaseCatalogRepository,
)
from business_assistant_server.adapters.supabase_sale_carts import SaleCartBundle
from business_assistant_server.adapters.supabase_visit_payments import VisitPayments
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.api.finance import (
    require_finance_management_role,
    require_finance_member,
)
from business_assistant_server.api.sale_carts import (
    OperationRequest,
    VersionedOperationRequest,
    _safe_errors,
)
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)

router = APIRouter(
    prefix="/organizations/{organization_id}",
    tags=["catalog"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("finance.basic")),
        Depends(require_finance_member),
    ],
)
PositiveMoney = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,11}$")]
NonnegativeMoney = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,11})$")]


class SaveProductRequest(OperationRequest):
    sku: Annotated[str, Field(min_length=1, max_length=80)]
    name: Annotated[str, Field(min_length=1, max_length=200)]
    kind: Literal["product", "membership"]
    unit_name: Annotated[str, Field(min_length=1, max_length=30)] = "개"
    sale_price: PositiveMoney
    benefit_money: NonnegativeMoney = "0"
    benefit_count: Annotated[int, Field(ge=0, le=999999, strict=True)] = 0
    valid_days: Annotated[int, Field(ge=1, le=3650, strict=True)] | None = None
    is_active: StrictBool = True

    @field_validator("sku", "name", "unit_name")
    @classmethod
    def strip_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A non-empty value is required")
        return value.strip()

    @model_validator(mode="after")
    def benefits_match_kind(self) -> "SaveProductRequest":
        has_benefit = int(self.benefit_money) > 0 or self.benefit_count > 0
        if self.kind == "product" and (has_benefit or self.valid_days is not None):
            raise ValueError("Physical products cannot grant membership benefits")
        if self.kind == "membership" and not has_benefit:
            raise ValueError("Membership benefits are required")
        return self


class UpdateProductRequest(SaveProductRequest):
    expected_version: Annotated[int, Field(ge=1, strict=True)]


class ReceiveStockRequest(OperationRequest):
    quantity: Annotated[int, Field(ge=1, le=999999, strict=True)]
    reason: Annotated[str, Field(min_length=1, max_length=1000)]

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Receipt reason is required")
        return value.strip()


class StockAdjustmentRequest(OperationRequest):
    kind: Literal["supplier_return", "disposal", "stocktake"]
    quantity: Annotated[int, Field(ge=0, le=1_000_000_000, strict=True)]
    reason: Annotated[str, Field(min_length=1, max_length=1000)]
    expected_version: Annotated[int, Field(ge=1, strict=True)]

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A stock adjustment reason is required")
        return value.strip()

    @model_validator(mode="after")
    def quantity_matches_kind(self) -> "StockAdjustmentRequest":
        if self.kind != "stocktake" and self.quantity == 0:
            raise ValueError("Return and disposal quantities must be positive")
        if self.kind != "stocktake" and self.quantity > 999999:
            raise ValueError("Return and disposal quantities cannot exceed 999999")
        return self


class AddCatalogRequest(VersionedOperationRequest):
    product_id: UUID


class UseWalletRequest(OperationRequest):
    wallet_id: UUID
    sale_line_id: UUID
    mode: Literal["money", "count"]
    amount: PositiveMoney | None = None
    expected_cart_version: Annotated[int, Field(ge=1, strict=True)]
    confirmed: StrictBool

    @model_validator(mode="after")
    def usage_matches_mode(self) -> "UseWalletRequest":
        if not self.confirmed:
            raise ValueError("Wallet usage confirmation is required")
        if (self.mode == "money") != (self.amount is not None):
            raise ValueError("Money usage requires an amount; count usage does not")
        return self


class ManageWalletRequest(VersionedOperationRequest):
    action: Literal["pause", "resume", "extend"]
    extend_days: Annotated[int, Field(ge=1, le=3650, strict=True)] | None = None
    reason: Annotated[str, Field(min_length=1, max_length=1000)]

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Wallet change reason is required")
        return value.strip()

    @model_validator(mode="after")
    def days_match_action(self) -> "ManageWalletRequest":
        if (self.action == "extend") != (self.extend_days is not None):
            raise ValueError("Extension days are required only for extension")
        return self


def get_catalog_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SupabaseCatalogRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Catalog service unavailable")
    return SupabaseCatalogRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


Repository = Annotated[SupabaseCatalogRepository, Depends(get_catalog_repository)]


@router.get("/catalog-products", response_model=list[CatalogProduct])
async def list_products(organization_id: UUID, repository: Repository) -> list[CatalogProduct]:
    with _safe_errors():
        return await repository.list_products(organization_id)


@router.post(
    "/catalog-products",
    response_model=CatalogProduct,
    status_code=201,
    dependencies=[Depends(require_finance_management_role)],
)
async def create_product(
    organization_id: UUID, request: SaveProductRequest, repository: Repository
) -> CatalogProduct:
    with _safe_errors():
        return await repository.save_product(
            organization_id,
            None,
            None,
            request.operation_id,
            request.model_dump(mode="json", exclude={"operation_id"}),
        )


@router.get(
    "/catalog-products/{product_id}/stock-ledger",
    response_model=list[CatalogStockMovement],
)
async def list_stock_ledger(
    organization_id: UUID, product_id: UUID, repository: Repository
) -> list[CatalogStockMovement]:
    with _safe_errors():
        return await repository.list_stock_ledger(organization_id, product_id)


@router.put(
    "/catalog-products/{product_id}",
    response_model=CatalogProduct,
    dependencies=[Depends(require_finance_management_role)],
)
async def update_product(
    organization_id: UUID, product_id: UUID, request: UpdateProductRequest, repository: Repository
) -> CatalogProduct:
    with _safe_errors():
        return await repository.save_product(
            organization_id,
            product_id,
            request.expected_version,
            request.operation_id,
            request.model_dump(mode="json", exclude={"operation_id", "expected_version"}),
        )


@router.post(
    "/catalog-products/{product_id}/stock-receipts",
    response_model=CatalogProduct,
    dependencies=[Depends(require_finance_management_role)],
)
async def receive_stock(
    organization_id: UUID, product_id: UUID, request: ReceiveStockRequest, repository: Repository
) -> CatalogProduct:
    with _safe_errors():
        return await repository.receive_stock(
            organization_id, product_id, request.quantity, request.reason, request.operation_id
        )


@router.post(
    "/catalog-products/{product_id}/stock-adjustments",
    response_model=CatalogProduct,
    dependencies=[Depends(require_finance_management_role)],
)
async def change_stock(
    organization_id: UUID,
    product_id: UUID,
    request: StockAdjustmentRequest,
    repository: Repository,
) -> CatalogProduct:
    with _safe_errors():
        return await repository.change_stock(
            organization_id,
            product_id,
            request.kind,
            request.quantity,
            request.reason,
            request.expected_version,
            request.operation_id,
        )


@router.post(
    "/visits/{visit_id}/sale-cart/lines/catalog-product",
    response_model=SaleCartBundle,
    dependencies=[Depends(require_finance_management_role)],
)
async def add_product(
    organization_id: UUID, visit_id: UUID, request: AddCatalogRequest, repository: Repository
) -> SaleCartBundle:
    with _safe_errors():
        return await repository.add_product(
            organization_id,
            visit_id,
            request.product_id,
            request.expected_version,
            request.operation_id,
        )


@router.get("/customers/{customer_id}/wallets", response_model=list[CustomerWallet])
async def list_wallets(
    organization_id: UUID, customer_id: UUID, repository: Repository
) -> list[CustomerWallet]:
    with _safe_errors():
        return await repository.list_wallets(organization_id, customer_id)


@router.post(
    "/customers/{customer_id}/wallets/{wallet_id}/lifecycle",
    response_model=CustomerWallet,
    dependencies=[Depends(require_finance_management_role)],
)
async def manage_wallet(
    organization_id: UUID,
    customer_id: UUID,
    wallet_id: UUID,
    request: ManageWalletRequest,
    repository: Repository,
) -> CustomerWallet:
    with _safe_errors():
        return await repository.manage_wallet(
            organization_id,
            customer_id,
            wallet_id,
            request.action,
            request.extend_days,
            request.reason,
            request.expected_version,
            request.operation_id,
        )


@router.post(
    "/visits/{visit_id}/wallet-usages",
    response_model=VisitPayments,
    dependencies=[Depends(require_finance_management_role)],
)
async def use_wallet(
    organization_id: UUID,
    visit_id: UUID,
    request: UseWalletRequest,
    repository: Repository,
) -> VisitPayments:
    with _safe_errors():
        return await repository.use_wallet(
            organization_id,
            visit_id,
            request.wallet_id,
            request.sale_line_id,
            request.mode,
            request.amount,
            request.expected_cart_version,
            request.operation_id,
            request.confirmed,
        )
