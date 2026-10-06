"""Organization-scoped visit sale carts through user-token PostgREST calls."""

import json as json_module
from decimal import Decimal
from typing import Literal, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ValidationError

from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)


class CustomerVisit(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    appointment_id: UUID | None
    status: Literal["open", "checkout_ready", "closed", "canceled"]
    opened_at: str
    closed_at: str | None
    version: int


class SaleCart(BaseModel):
    id: UUID
    organization_id: UUID
    visit_id: UUID
    customer_id: UUID
    status: Literal["draft", "ready", "void", "collecting", "paid"]
    version: int
    subtotal: Decimal
    discount_total: Decimal
    total_amount: Decimal


class SaleCartLine(BaseModel):
    id: UUID
    organization_id: UUID
    cart_id: UUID
    source_type: Literal["treatment_draft", "product", "membership"]
    source_id: UUID
    description_snapshot: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal
    staff_id: UUID | None
    staff_name_snapshot: str
    source_snapshot: dict[str, object]
    status: Literal["active", "removed"]
    removal_reason: str
    created_at: str
    removed_at: str | None


class SaleCartBundle(BaseModel):
    visit: CustomerVisit
    cart: SaleCart
    lines: list[SaleCartLine]


class SaleCartRepository(Protocol):
    async def list_visits(
        self, organization_id: UUID, customer_id: UUID | None = None, status: str | None = None
    ) -> list[CustomerVisit]: ...

    async def create_visit(
        self, organization_id: UUID, customer_id: UUID, operation_id: UUID
    ) -> SaleCartBundle: ...

    async def get_cart(self, organization_id: UUID, visit_id: UUID) -> SaleCartBundle: ...

    async def add_treatment_draft(
        self,
        organization_id: UUID,
        visit_id: UUID,
        draft_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> SaleCartBundle: ...

    async def mutate_line(
        self,
        organization_id: UUID,
        visit_id: UUID,
        line_id: UUID,
        expected_version: int,
        operation_id: UUID,
        action: str,
        values: dict[str, object],
    ) -> SaleCartBundle: ...

    async def review(
        self,
        organization_id: UUID,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
        ready: bool,
    ) -> SaleCartBundle: ...

    async def cancel_visit(
        self,
        organization_id: UUID,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> SaleCartBundle: ...


class SupabaseSaleCartRepository:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {"apikey": publishable_key, "Authorization": f"Bearer {access_token}"}
        self._client = client

    async def list_visits(
        self, organization_id: UUID, customer_id: UUID | None = None, status: str | None = None
    ) -> list[CustomerVisit]:
        params = {"organization_id": f"eq.{organization_id}", "order": "opened_at.desc,id.desc"}
        if customer_id is not None:
            params["customer_id"] = f"eq.{customer_id}"
        if status is not None:
            params["status"] = f"eq.{status}"
        result: list[CustomerVisit] = []
        seen: set[UUID] = set()
        while True:
            payload = await self._request(
                "GET",
                "customer_visits",
                params={**params, "limit": "200", "offset": str(len(result))},
            )
            if not isinstance(payload, list):
                raise RepositoryUnavailableError()
            if not payload:
                return result
            try:
                rows = [CustomerVisit.model_validate(row) for row in payload]
            except ValidationError as error:
                raise RepositoryUnavailableError() from error
            for row in rows:
                if row.organization_id != organization_id or row.id in seen:
                    raise RepositoryUnavailableError()
                seen.add(row.id)
            result.extend(rows)

    async def create_visit(
        self, organization_id: UUID, customer_id: UUID, operation_id: UUID
    ) -> SaleCartBundle:
        return await self._rpc(
            "create_customer_visit",
            p_organization_id=str(organization_id),
            p_customer_id=str(customer_id),
            p_operation_id=str(operation_id),
        )

    async def get_cart(self, organization_id: UUID, visit_id: UUID) -> SaleCartBundle:
        bundle = await self._rpc(
            "get_visit_sale_cart", p_organization_id=str(organization_id), p_visit_id=str(visit_id)
        )
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

    async def add_treatment_draft(
        self,
        organization_id: UUID,
        visit_id: UUID,
        draft_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> SaleCartBundle:
        return await self._rpc(
            "add_treatment_draft_to_cart",
            p_organization_id=str(organization_id),
            p_visit_id=str(visit_id),
            p_draft_id=str(draft_id),
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
        )

    async def mutate_line(
        self,
        organization_id: UUID,
        visit_id: UUID,
        line_id: UUID,
        expected_version: int,
        operation_id: UUID,
        action: str,
        values: dict[str, object],
    ) -> SaleCartBundle:
        return await self._rpc(
            "mutate_sale_cart_line",
            p_organization_id=str(organization_id),
            p_visit_id=str(visit_id),
            p_line_id=str(line_id),
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
            p_action=action,
            p_values=values,
        )

    async def review(
        self,
        organization_id: UUID,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
        ready: bool,
    ) -> SaleCartBundle:
        return await self._rpc(
            "review_sale_cart",
            p_organization_id=str(organization_id),
            p_visit_id=str(visit_id),
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
            p_ready=ready,
        )

    async def cancel_visit(
        self,
        organization_id: UUID,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> SaleCartBundle:
        return await self._rpc(
            "cancel_customer_visit",
            p_organization_id=str(organization_id),
            p_visit_id=str(visit_id),
            p_expected_version=expected_version,
            p_operation_id=str(operation_id),
        )

    async def _rpc(self, name: str, **payload: object) -> SaleCartBundle:
        return self._bundle(await self._request("POST", f"rpc/{name}", json=payload))

    @staticmethod
    def _bundle(payload: object) -> SaleCartBundle:
        try:
            return SaleCartBundle.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
    ) -> object:
        try:
            if self._client is not None:
                response = await self._client.request(
                    method, f"{self._base}/{path}", params=params, json=json, headers=self._headers
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._base}/{path}",
                        params=params,
                        json=json,
                        headers=self._headers,
                    )
            response.raise_for_status()
            return json_module.loads(response.content, parse_float=Decimal)
        except httpx.HTTPStatusError as error:
            try:
                failure = json_module.loads(error.response.content)
                code = failure.get("code") if isinstance(failure, dict) else None
            except ValueError:
                code = None
            mapped = {
                "P0001": RepositoryConflictError,
                "23505": RepositoryConflictError,
                "P0002": RepositoryNotFoundError,
                "42501": RepositoryPermissionError,
                "22023": RepositoryValidationError,
                "23514": RepositoryValidationError,
                "22P02": RepositoryValidationError,
            }
            if isinstance(code, str) and code in mapped:
                raise mapped[code]() from error
            raise RepositoryUnavailableError() from error
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
