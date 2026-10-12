"""Catalog and issued wallets, accessed only with the caller's organization scope."""

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError, field_validator

from business_assistant_server.adapters.supabase_sale_carts import (
    SaleCartBundle,
    SupabaseSaleCartRepository,
)
from business_assistant_server.adapters.supabase_visit_payments import VisitPayments
from business_assistant_server.ports.repositories import RepositoryUnavailableError

WholeMoney = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=0, allow_inf_nan=False)]


class CatalogProduct(BaseModel):
    id: UUID
    organization_id: UUID
    sku: str
    name: str
    kind: Literal["product", "membership"]
    unit_name: str
    sale_price: WholeMoney
    benefit_money: WholeMoney
    benefit_count: Annotated[int, Field(ge=0)]
    valid_days: Annotated[int, Field(ge=1, le=3650)] | None
    is_active: bool
    version: Annotated[int, Field(ge=1)]
    stock_quantity: Annotated[int, Field(ge=0)]


class CatalogStockMovement(BaseModel):
    id: UUID
    organization_id: UUID
    product_id: UUID
    movement_kind: Literal[
        "receipt", "sale", "refund", "customer_return", "supplier_return", "disposal", "stocktake"
    ]
    quantity: Annotated[int, Field(strict=True)]
    reason: str
    created_by: UUID
    created_at: str

    @field_validator("quantity")
    @classmethod
    def reject_zero_quantity(cls, value: int) -> int:
        if value == 0:
            raise ValueError("Stock movement quantity cannot be zero")
        return value


class CustomerWallet(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    product_id: UUID
    sale_line_id: UUID
    name_snapshot: str
    money_balance: WholeMoney
    count_balance: Annotated[int, Field(ge=0)]
    valid_from: date
    expires_on: date | None
    source_snapshot: dict[str, object]
    created_at: str
    lifecycle_status: Literal["active", "paused"] = "active"
    paused_on: date | None = None
    lifecycle_version: Annotated[int, Field(ge=1)] = 1
    usage_history: list["WalletUsage"] = Field(default_factory=list)


class WalletUsage(BaseModel):
    id: UUID
    visit_id: UUID
    sale_line_id: UUID
    mode: Literal["money", "count"]
    money_delta: Decimal = Field(le=0, allow_inf_nan=False)
    count_delta: Annotated[int, Field(ge=-1, le=0)]
    applied_amount: Decimal = Field(gt=0, allow_inf_nan=False)
    created_at: str


class SupabaseCatalogRepository(SupabaseSaleCartRepository):
    async def _catalog_rpc(self, name: str, organization_id: UUID, **values: object) -> object:
        return await self._request(
            "POST", f"rpc/{name}", json={"p_organization_id": str(organization_id), **values}
        )

    @staticmethod
    def _product(
        payload: object, organization_id: UUID, product_id: UUID | None = None
    ) -> CatalogProduct:
        try:
            result = CatalogProduct.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if result.organization_id != organization_id or (
            product_id is not None and result.id != product_id
        ):
            raise RepositoryUnavailableError()
        return result

    async def list_products(self, organization_id: UUID) -> list[CatalogProduct]:
        payload = await self._catalog_rpc("list_catalog_products", organization_id)
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        rows = [self._product(item, organization_id) for item in payload]
        if len({row.id for row in rows}) != len(rows):
            raise RepositoryUnavailableError()
        return rows

    async def save_product(
        self,
        organization_id: UUID,
        product_id: UUID | None,
        expected_version: int | None,
        operation_id: UUID,
        values: dict[str, object],
    ) -> CatalogProduct:
        payload = await self._catalog_rpc(
            "save_catalog_product",
            organization_id,
            p_product_id=str(product_id) if product_id else None,
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
            p_values=values,
        )
        return self._product(payload, organization_id, product_id)

    async def receive_stock(
        self,
        organization_id: UUID,
        product_id: UUID,
        quantity: int,
        reason: str,
        operation_id: UUID,
    ) -> CatalogProduct:
        payload = await self._catalog_rpc(
            "receive_catalog_stock",
            organization_id,
            p_product_id=str(product_id),
            p_quantity=quantity,
            p_reason=reason,
            p_operation_id=str(operation_id),
        )
        return self._product(payload, organization_id, product_id)

    async def change_stock(
        self,
        organization_id: UUID,
        product_id: UUID,
        kind: str,
        quantity: int,
        reason: str,
        expected_version: int,
        operation_id: UUID,
    ) -> CatalogProduct:
        payload = await self._catalog_rpc(
            "change_catalog_stock",
            organization_id,
            p_product_id=str(product_id),
            p_kind=kind,
            p_quantity=quantity,
            p_reason=reason,
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
        )
        return self._product(payload, organization_id, product_id)

    async def list_stock_ledger(
        self, organization_id: UUID, product_id: UUID
    ) -> list[CatalogStockMovement]:
        payload = await self._catalog_rpc(
            "list_catalog_stock_ledger", organization_id, p_product_id=str(product_id)
        )
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        try:
            rows = [CatalogStockMovement.model_validate(row) for row in payload]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if len({row.id for row in rows}) != len(rows) or any(
            row.organization_id != organization_id or row.product_id != product_id for row in rows
        ):
            raise RepositoryUnavailableError()
        return rows

    async def add_product(
        self,
        organization_id: UUID,
        visit_id: UUID,
        product_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> SaleCartBundle:
        payload = await self._catalog_rpc(
            "add_catalog_product_to_cart",
            organization_id,
            p_visit_id=str(visit_id),
            p_product_id=str(product_id),
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
        )
        bundle = self._bundle(payload)
        if (
            bundle.visit.organization_id != organization_id
            or bundle.visit.id != visit_id
            or bundle.cart.organization_id != organization_id
            or bundle.cart.visit_id != visit_id
            or bundle.cart.customer_id != bundle.visit.customer_id
            or any(
                line.organization_id != organization_id or line.cart_id != bundle.cart.id
                for line in bundle.lines
            )
        ):
            raise RepositoryUnavailableError()
        return bundle

    async def list_wallets(self, organization_id: UUID, customer_id: UUID) -> list[CustomerWallet]:
        payload = await self._catalog_rpc(
            "list_customer_wallets", organization_id, p_customer_id=str(customer_id)
        )
        if not isinstance(payload, list):
            raise RepositoryUnavailableError()
        try:
            rows = [CustomerWallet.model_validate(row) for row in payload]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if len({row.id for row in rows}) != len(rows) or any(
            row.organization_id != organization_id
            or row.customer_id != customer_id
            or (row.expires_on is not None and row.expires_on < row.valid_from)
            for row in rows
        ):
            raise RepositoryUnavailableError()
        return rows

    async def manage_wallet(
        self,
        organization_id: UUID,
        customer_id: UUID,
        wallet_id: UUID,
        action: str,
        extend_days: int | None,
        reason: str,
        expected_version: int,
        operation_id: UUID,
    ) -> CustomerWallet:
        payload = await self._catalog_rpc(
            "manage_customer_wallet",
            organization_id,
            p_customer_id=str(customer_id),
            p_wallet_id=str(wallet_id),
            p_action=action,
            p_extend_days=extend_days,
            p_reason=reason,
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
        )
        try:
            result = CustomerWallet.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if (
            result.organization_id != organization_id
            or result.customer_id != customer_id
            or result.id != wallet_id
        ):
            raise RepositoryUnavailableError()
        return result

    async def use_wallet(
        self,
        organization_id: UUID,
        visit_id: UUID,
        wallet_id: UUID,
        sale_line_id: UUID,
        mode: str,
        amount: str | None,
        expected_cart_version: int,
        operation_id: UUID,
        confirmed: bool,
    ) -> VisitPayments:
        payload = await self._catalog_rpc(
            "use_customer_wallet",
            organization_id,
            p_visit_id=str(visit_id),
            p_wallet_id=str(wallet_id),
            p_sale_line_id=str(sale_line_id),
            p_mode=mode,
            p_amount=amount,
            p_expected_cart_version=expected_cart_version,
            p_operation_id=str(operation_id),
            p_confirmed=confirmed,
        )
        try:
            result = VisitPayments.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if result.visit_id != visit_id:
            raise RepositoryUnavailableError()
        return result
