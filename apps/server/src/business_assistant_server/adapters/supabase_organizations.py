import base64
import json
import logging
from datetime import datetime
from typing import Any, TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from business_assistant_server.ports.repositories import (
    MemberSummary,
    OrganizationSummary,
    RepositoryUnavailableError,
    SubscriptionSummary,
)

ModelT = TypeVar("ModelT", bound=BaseModel)
logger = logging.getLogger(__name__)


class _OrganizationRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    name: str
    slug: str


class _MembershipRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str
    organizations: _OrganizationRow | None = None


class _MemberRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_id: UUID
    role: str


class _PlanFeatureRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    feature_code: str


class _PlanRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str
    plan_features: list[_PlanFeatureRow]


class _SubscriptionRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: str
    ends_at: datetime | None
    plans: _PlanRow | None = None


class SupabaseOrganizationRepository:
    """PostgREST adapter that relies on the authenticated user's RLS context."""

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

    async def create_organization(
        self,
        user_id: UUID,
        name: str,
        slug: str,
    ) -> OrganizationSummary:
        del user_id
        rows = await self._request_rows(
            "POST",
            "organizations",
            json={"name": name, "slug": slug},
            headers={"Prefer": "return=representation"},
        )
        organization = self._parse_one(rows, _OrganizationRow)
        return OrganizationSummary(organization.id, organization.name, organization.slug, "owner")

    async def list_organizations_for_user(self, user_id: UUID) -> list[OrganizationSummary]:
        rows = await self._request_rows(
            "GET",
            "memberships",
            params={"select": "role,organizations(id,name,slug)", "user_id": f"eq.{user_id}"},
        )
        memberships = self._parse_rows(rows, _MembershipRow)
        return [
            OrganizationSummary(
                row.organizations.id,
                row.organizations.name,
                row.organizations.slug,
                row.role,
            )
            for row in memberships
            if row.organizations is not None
        ]

    async def get_organization(self, organization_id: UUID) -> OrganizationSummary | None:
        rows = await self._request_rows(
            "GET",
            "organizations",
            params={"select": "id,name,slug", "id": f"eq.{organization_id}"},
        )
        if not rows:
            return None
        organization = self._parse_one(rows, _OrganizationRow)
        return OrganizationSummary(organization.id, organization.name, organization.slug, "member")

    async def organization_exists(self, organization_id: UUID) -> bool:
        payload = await self._request_value(
            "POST", "rpc/organization_exists", json={"target_organization_id": str(organization_id)}
        )
        if not isinstance(payload, bool):
            raise RepositoryUnavailableError()
        return payload

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        rows = await self._request_rows(
            "GET",
            "memberships",
            params={
                "select": "role",
                "organization_id": f"eq.{organization_id}",
                "user_id": f"eq.{user_id}",
            },
        )
        if not rows:
            return None
        return self._parse_one(rows, _MembershipRow).role

    async def list_members(self, organization_id: UUID) -> list[MemberSummary]:
        rows = await self._request_rows(
            "GET",
            "memberships",
            params={"select": "user_id,role", "organization_id": f"eq.{organization_id}"},
        )
        return [MemberSummary(row.user_id, row.role) for row in self._parse_rows(rows, _MemberRow)]

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None:
        rows = await self._request_rows(
            "GET",
            "subscriptions",
            params={
                "select": "status,ends_at,plans(code,plan_features(feature_code))",
                "organization_id": f"eq.{organization_id}",
                "status": "in.(trialing,active)",
                "or": f"(ends_at.is.null,ends_at.gt.{now.isoformat()})",
                "order": "starts_at.desc",
                "limit": "1",
            },
        )
        if not rows:
            return None
        subscription = self._parse_one(rows, _SubscriptionRow)
        if subscription.plans is None:
            raise RepositoryUnavailableError()
        return SubscriptionSummary(
            organization_id=organization_id,
            plan_code=subscription.plans.code,
            status=subscription.status,
            ends_at=subscription.ends_at,
            features=sorted(feature.feature_code for feature in subscription.plans.plan_features),
        )

    async def _request_rows(
        self,
        method: str,
        resource: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        request_headers = {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {self._access_token}",
            **(headers or {}),
        }
        if method == "POST" and resource == "organizations":
            logger.warning("Organization create JWT claims: %s", _jwt_claims(self._access_token))
        try:
            if self._client is not None:
                response = await self._client.request(
                    method,
                    f"{self._rest_url}/{resource}",
                    params=params,
                    json=json,
                    headers=request_headers,
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method,
                        f"{self._rest_url}/{resource}",
                        params=params,
                        json=json,
                        headers=request_headers,
                    )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.warning(
                "Supabase organization request failed: %s %s", method, _error_message(error)
            )
            raise RepositoryUnavailableError() from error
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RepositoryUnavailableError()
        return payload

    async def _request_value(self, method: str, resource: str, *, json: dict[str, str]) -> object:
        request_headers = {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {self._access_token}",
        }
        try:
            if self._client is not None:
                response = await self._client.request(
                    method, f"{self._rest_url}/{resource}", json=json, headers=request_headers
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.request(
                        method, f"{self._rest_url}/{resource}", json=json, headers=request_headers
                    )
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("Supabase organization RPC failed: %s %s", method, _error_message(error))
            raise RepositoryUnavailableError() from error

    @staticmethod
    def _parse_rows(rows: list[dict[str, Any]], model: type[ModelT]) -> list[ModelT]:
        try:
            return [model.model_validate(row) for row in rows]
        except ValidationError as error:
            raise RepositoryUnavailableError() from error

    @staticmethod
    def _parse_one(rows: list[dict[str, Any]], model: type[ModelT]) -> ModelT:
        if not rows:
            raise RepositoryUnavailableError()
        return SupabaseOrganizationRepository._parse_rows(rows[:1], model)[0]


def _error_message(error: Exception) -> str:
    response = getattr(error, "response", None)
    if response is not None:
        detail = getattr(response, "text", "")
        if detail:
            return " ".join(str(detail).split())[:500]
    return " ".join(str(error).split())[:500]


def _jwt_claims(token: str) -> dict[str, str]:
    """Expose only non-sensitive JWT routing claims for local diagnostics."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        return {key: str(claims[key]) for key in ("role", "sub", "aud") if key in claims}
    except (IndexError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {"invalid": "true"}
