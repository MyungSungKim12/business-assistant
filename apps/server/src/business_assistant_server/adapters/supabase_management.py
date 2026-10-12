"""Manager-only, read-only preview of recorded cash flow and sales attribution."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from business_assistant_server.adapters.supabase_sale_carts import SupabaseSaleCartRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError


class StaffSalesBasis(BaseModel):
    staff_id: UUID | None
    staff_name_snapshot: str
    line_count: int = Field(ge=0)
    gross_line_total: Decimal = Field(ge=0)


class ManagementPreview(BaseModel):
    organization_id: UUID
    from_date: date
    to_date: date
    recorded_income: Decimal
    recorded_expense: Decimal
    recorded_net: Decimal
    transaction_count: int = Field(ge=0)
    visit_receipts: Decimal
    visit_refunds: Decimal
    staff_sales_basis: list[StaffSalesBasis]
    is_final_profit: bool
    excluded_costs: list[str]
    staff_basis_is_commission: bool


class SupabaseManagementRepository(SupabaseSaleCartRepository):
    async def get_preview(
        self, organization_id: UUID, from_date: date, to_date: date
    ) -> ManagementPreview:
        payload = await self._request(
            "POST",
            "rpc/get_management_preview",
            json={
                "p_organization_id": str(organization_id),
                "p_from_date": from_date.isoformat(),
                "p_to_date": to_date.isoformat(),
            },
        )
        try:
            result = ManagementPreview.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if (
            result.organization_id != organization_id
            or result.from_date != from_date
            or result.to_date != to_date
            or result.is_final_profit
            or result.staff_basis_is_commission
        ):
            raise RepositoryUnavailableError()
        return result
