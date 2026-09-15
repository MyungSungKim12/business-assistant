from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable
from uuid import UUID


class RepositoryUnavailableError(Exception):
    """The organization repository cannot safely complete a request."""

    def __init__(self) -> None:
        super().__init__("Organization service unavailable")


@dataclass(frozen=True, slots=True)
class OrganizationSummary:
    id: UUID
    name: str
    slug: str
    role: str


@dataclass(frozen=True, slots=True)
class MemberSummary:
    user_id: UUID
    role: str


@dataclass(frozen=True, slots=True)
class SubscriptionSummary:
    organization_id: UUID
    plan_code: str
    status: str
    ends_at: datetime | None
    features: list[str]


@runtime_checkable
class OrganizationRepository(Protocol):
    """Organization data access scoped to the authenticated user."""

    async def create_organization(
        self, user_id: UUID, name: str, slug: str
    ) -> OrganizationSummary: ...

    async def list_organizations_for_user(self, user_id: UUID) -> list[OrganizationSummary]: ...

    async def get_organization(self, organization_id: UUID) -> OrganizationSummary | None: ...

    async def organization_exists(self, organization_id: UUID) -> bool: ...

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None: ...

    async def list_members(self, organization_id: UUID) -> list[MemberSummary]: ...

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None: ...
