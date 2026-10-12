"""Daily sales settlement RPC adapter."""

from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from business_assistant_server.adapters.supabase_sale_carts import SupabaseSaleCartRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError

Money = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=0, allow_inf_nan=False)]


class SaleReceivable(BaseModel):
    cart_id: UUID
    visit_id: UUID
    customer_id: UUID
    customer_name: str
    total_amount: Money
    received_amount: Money
    refunded_amount: Money
    due_amount: Money


class SaleCloseAdjustment(BaseModel):
    version: int
    previous_counted_cash: Money
    counted_cash: Money
    reason: str
    adjusted_by: UUID
    adjusted_at: str


class SaleDailyClose(BaseModel):
    id: UUID
    version: int
    expected_cash: Money
    counted_cash: Money
    variance: Decimal
    reason: str
    closed_by: UUID
    closed_at: str
    adjustments: list[SaleCloseAdjustment]


class SaleDailySettlement(BaseModel):
    organization_id: UUID
    business_date: date
    cash_received: Money
    cash_refunded: Money
    expected_cash: Decimal
    card_received: Money
    card_refunded: Money
    transfer_received: Money
    transfer_refunded: Money
    receipt_count: int
    refund_count: int
    receivables: list[SaleReceivable]
    is_closed: bool
    close: SaleDailyClose | None


class SupabaseSaleSettlementRepository(SupabaseSaleCartRepository):
    def _settlement(
        self, payload: object, organization_id: UUID, business_date: date
    ) -> SaleDailySettlement:
        try:
            settlement = SaleDailySettlement.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if (
            settlement.organization_id != organization_id
            or settlement.business_date != business_date
            or settlement.is_closed != (settlement.close is not None)
        ):
            raise RepositoryUnavailableError()
        return settlement

    async def get_daily_settlement(
        self, organization_id: UUID, business_date: date
    ) -> SaleDailySettlement:
        payload = await self._request(
            "POST",
            "rpc/get_sale_daily_settlement",
            json={
                "p_organization_id": str(organization_id),
                "p_business_date": business_date.isoformat(),
            },
        )
        return self._settlement(payload, organization_id, business_date)

    async def close_day(
        self,
        organization_id: UUID,
        business_date: date,
        counted_cash: str,
        reason: str,
        operation_id: UUID,
        confirmed: bool,
    ) -> SaleDailySettlement:
        payload = await self._request(
            "POST",
            "rpc/close_sale_daily",
            json={
                "p_organization_id": str(organization_id),
                "p_business_date": business_date.isoformat(),
                "p_counted_cash": counted_cash,
                "p_reason": reason,
                "p_operation_id": str(operation_id),
                "p_confirmed": confirmed,
            },
        )
        return self._settlement(payload, organization_id, business_date)

    async def adjust_close(
        self,
        organization_id: UUID,
        business_date: date,
        expected_version: int,
        counted_cash: str,
        reason: str,
        operation_id: UUID,
        confirmed: bool,
    ) -> SaleDailySettlement:
        payload = await self._request(
            "POST",
            "rpc/adjust_sale_daily_close",
            json={
                "p_organization_id": str(organization_id),
                "p_business_date": business_date.isoformat(),
                "p_expected_version": expected_version,
                "p_counted_cash": counted_cash,
                "p_reason": reason,
                "p_operation_id": str(operation_id),
                "p_confirmed": confirmed,
            },
        )
        return self._settlement(payload, organization_id, business_date)
