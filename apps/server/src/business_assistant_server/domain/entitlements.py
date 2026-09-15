from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from business_assistant_server.ports.repositories import OrganizationRepository, SubscriptionSummary


@dataclass(frozen=True, slots=True)
class EntitlementResponse:
    organization_id: UUID
    plan_code: str | None
    features: list[str]


class EntitlementService:
    def __init__(self, repository: OrganizationRepository) -> None:
        self._repository = repository

    async def get_active_entitlements(
        self, user_id: UUID, organization_id: UUID
    ) -> EntitlementResponse:
        await self._require_membership(user_id, organization_id)
        subscription = await self._repository.get_active_subscription(
            organization_id, datetime.now(UTC)
        )
        if subscription is None:
            return EntitlementResponse(organization_id=organization_id, plan_code=None, features=[])
        return EntitlementResponse(
            organization_id=organization_id,
            plan_code=subscription.plan_code,
            features=sorted(subscription.features),
        )

    async def get_current_subscription(
        self, user_id: UUID, organization_id: UUID
    ) -> SubscriptionSummary:
        await self._require_membership(user_id, organization_id)
        subscription = await self._repository.get_active_subscription(
            organization_id, datetime.now(UTC)
        )
        if subscription is None:
            raise LookupError("Active subscription not found")
        return SubscriptionSummary(
            organization_id=subscription.organization_id,
            plan_code=subscription.plan_code,
            status=subscription.status,
            ends_at=subscription.ends_at,
            features=sorted(subscription.features),
        )

    async def _require_membership(self, user_id: UUID, organization_id: UUID) -> None:
        if not await self._repository.organization_exists(organization_id):
            raise LookupError("Organization not found")
        if await self._repository.get_membership(user_id, organization_id) is None:
            raise PermissionError("Organization membership required")
