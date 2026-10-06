"""Immutable external receipt records; never sends a card authorization."""

from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from business_assistant_server.adapters.supabase_sale_carts import SupabaseSaleCartRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError


class PaymentReceipt(BaseModel):
    id: UUID
    method: Literal["cash", "card", "transfer"]
    amount: Decimal = Field(gt=0, allow_inf_nan=False)
    reference: str
    received_at: str
    operation_id: UUID


class VisitPayments(BaseModel):
    visit_id: UUID
    cart_id: UUID
    cart_version: int = Field(ge=1)
    total_amount: Decimal = Field(ge=0, allow_inf_nan=False)
    paid_amount: Decimal = Field(ge=0, allow_inf_nan=False)
    outstanding_amount: Decimal = Field(ge=0, allow_inf_nan=False)
    currency: Literal["KRW"]
    status: Literal["draft", "ready", "collecting", "paid", "void"]
    receipts: list[PaymentReceipt]

    @model_validator(mode="after")
    def reconcile(self) -> "VisitPayments":
        if self.paid_amount + self.outstanding_amount != self.total_amount:
            raise ValueError("Receipt balance mismatch")
        if sum((r.amount for r in self.receipts), Decimal(0)) != self.paid_amount:
            raise ValueError("Receipt sum mismatch")
        return self


class SupabaseVisitPaymentRepository(SupabaseSaleCartRepository):
    async def get_payments(self, organization_id: UUID, visit_id: UUID) -> VisitPayments:
        return await self._payment_rpc("get_visit_payments", organization_id, visit_id)

    async def record_payment(
        self,
        organization_id: UUID,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
        payments: list[dict[str, object]],
        confirmed: bool,
    ) -> VisitPayments:
        return await self._payment_rpc(
            "record_visit_payment",
            organization_id,
            visit_id,
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
            p_payments=payments,
            p_confirmed=confirmed,
        )

    async def _payment_rpc(
        self,
        name: str,
        organization_id: UUID,
        visit_id: UUID,
        **values: object,
    ) -> VisitPayments:
        payload = await self._request(
            "POST",
            f"rpc/{name}",
            json={
                "p_organization_id": str(organization_id),
                "p_visit_id": str(visit_id),
                **values,
            },
        )
        try:
            result = VisitPayments.model_validate(payload)
            if result.visit_id != visit_id:
                raise ValueError("Unexpected visit")
            return result
        except ValueError as error:
            raise RepositoryUnavailableError() from error
