"""PostgREST adapter for organization-scoped finance transactions."""

from datetime import date
from decimal import Decimal
from typing import Any, TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    FinanceSummary,
    FinanceTransactionSummary,
    RepositoryUnavailableError,
)

ModelT = TypeVar("ModelT", bound=BaseModel)


class _FinanceRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

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


class SupabaseFinanceRepository:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._rest_url = f"{supabase_url.rstrip('/')}/rest/v1"
        self._publishable_key = publishable_key
        self._access_token = access_token
        self._client = client

    async def list_transactions(
        self,
        organization_id: UUID,
        from_date: date | None,
        to_date: date | None,
        transaction_type: str | None,
    ) -> list[FinanceTransactionSummary]:
        rows = await self._request_rows(
            "GET",
            params=self._filters(organization_id, from_date, to_date, transaction_type),
        )
        return [self._summary(row) for row in self._parse_rows(rows)]

    async def create_transaction(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary:
        rows = await self._request_rows(
            "POST",
            json={
                **self._json_values(values),
                "organization_id": str(organization_id),
                "created_by": str(created_by),
            },
            headers={"Prefer": "return=representation"},
        )
        return self._summary(self._parse_one(rows))

    async def update_transaction(
        self, organization_id: UUID, transaction_id: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary | None:
        rows = await self._request_rows(
            "PATCH",
            params={"id": f"eq.{transaction_id}", "organization_id": f"eq.{organization_id}"},
            json=self._json_values(values),
            headers={"Prefer": "return=representation"},
        )
        return self._summary(self._parse_one(rows)) if rows else None

    async def summarize_transactions(
        self, organization_id: UUID, from_date: date | None, to_date: date | None
    ) -> FinanceSummary:
        params = self._filters(organization_id, from_date, to_date, None)
        params["is_archived"] = "eq.false"
        params["select"] = "transaction_type,amount"
        rows = await self._request_rows("GET", params=params)
        income_total = Decimal("0")
        expense_total = Decimal("0")
        for row in rows:
            if not isinstance(row, dict):
                raise RepositoryUnavailableError()
            try:
                transaction_type = row["transaction_type"]
                amount = Decimal(str(row["amount"]))
            except (KeyError, TypeError, ValueError, ArithmeticError) as error:
                raise RepositoryUnavailableError() from error
            if transaction_type == "income":
                income_total += amount
            elif transaction_type == "expense":
                expense_total += amount
            else:
                raise RepositoryUnavailableError()
        return FinanceSummary(income_total, expense_total, income_total - expense_total, len(rows))

    @staticmethod
    def _filters(
        organization_id: UUID,
        from_date: date | None,
        to_date: date | None,
        transaction_type: str | None,
    ) -> dict[str, str]:
        params = {
            "select": (
                "id,organization_id,created_by,transaction_type,amount,transaction_date,"
                "category,counterparty,memo,is_archived,created_at,updated_at"
            ),
            "organization_id": f"eq.{organization_id}",
        }
        if from_date is not None and to_date is not None:
            params["and"] = (
                f"(transaction_date.gte.{from_date.isoformat()},"
                f"transaction_date.lte.{to_date.isoformat()})"
            )
        elif from_date is not None:
            params["transaction_date"] = f"gte.{from_date.isoformat()}"
        elif to_date is not None:
            params["transaction_date"] = f"lte.{to_date.isoformat()}"
        if transaction_type is not None:
            params["transaction_type"] = f"eq.{transaction_type}"
        return params

    async def _request_rows(
        self,
        method: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        request_headers = {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {self._access_token}",
            **(headers or {}),
        }
        try:
            if self._client is not None:
                response = await self._client.request(
                    method,
                    f"{self._rest_url}/finance_transactions",
                    params=params,
                    json=json,
                    headers=request_headers,
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._rest_url}/finance_transactions",
                        params=params,
                        json=json,
                        headers=request_headers,
                    )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    @staticmethod
    def _json_values(values: dict[str, object]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in values.items():
            if isinstance(value, Decimal):
                result[key] = str(value)
            elif isinstance(value, date):
                result[key] = value.isoformat()
            elif isinstance(value, UUID):
                result[key] = str(value)
            else:
                result[key] = value
        return result

    def _parse_rows(self, rows: list[dict[str, Any]]) -> list[_FinanceRow]:
        try:
            return [_FinanceRow.model_validate(row) for row in rows]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    def _parse_one(self, rows: list[dict[str, Any]]) -> _FinanceRow:
        if not rows:
            raise RepositoryUnavailableError()
        return self._parse_rows(rows[:1])[0]

    @staticmethod
    def _summary(row: _FinanceRow) -> FinanceTransactionSummary:
        return FinanceTransactionSummary(
            row.id,
            row.organization_id,
            row.created_by,
            row.transaction_type,
            row.amount,
            row.transaction_date.isoformat(),
            row.category,
            row.counterparty,
            row.memo,
            row.is_archived,
            row.created_at,
            row.updated_at,
        )
