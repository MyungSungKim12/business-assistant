import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from business_assistant_server.domain.entitlements import EntitlementService
from business_assistant_server.domain.organizations import OrganizationService

OWNER_ID = UUID("12345678-1234-5678-1234-567812345678")
OUTSIDER_ID = UUID("87654321-4321-8765-4321-876543218765")


@dataclass
class FakeRepository:
    organizations: list[object]
    memberships: dict[tuple[UUID, UUID], str]
    subscriptions: dict[UUID, object]

    async def create_organization(self, user_id: UUID, name: str, slug: str) -> object:
        from business_assistant_server.ports.repositories import OrganizationSummary

        organization = OrganizationSummary(id=uuid4(), name=name, slug=slug, role="owner")
        self.organizations.append(organization)
        self.memberships[(user_id, organization.id)] = "owner"
        return organization

    async def list_organizations_for_user(self, user_id: UUID) -> list[object]:
        return [
            organization
            for organization in self.organizations
            if (user_id, organization.id) in self.memberships
        ]

    async def get_organization(self, organization_id: UUID) -> object | None:
        return next((item for item in self.organizations if item.id == organization_id), None)

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None:
        return self.memberships.get((user_id, organization_id))

    async def list_members(self, organization_id: UUID) -> list[object]:
        from business_assistant_server.ports.repositories import MemberSummary

        return [
            MemberSummary(user_id=user_id, role=role)
            for (user_id, current_organization_id), role in self.memberships.items()
            if current_organization_id == organization_id
        ]

    async def get_active_subscription(self, organization_id: UUID, now: datetime) -> object | None:
        subscription = self.subscriptions.get(organization_id)
        if subscription is None:
            return None
        if subscription.status not in {"trialing", "active"}:
            return None
        if subscription.ends_at is not None and subscription.ends_at <= now:
            return None
        return subscription


def test_create_organization_assigns_creator_an_owner_membership() -> None:
    repository = FakeRepository([], {}, {})
    service = OrganizationService(repository)

    organization = asyncio.run(service.create_organization(OWNER_ID, "Hana Studio", "hana-studio"))

    assert organization.name == "Hana Studio"
    assert organization.slug == "hana-studio"
    assert organization.role == "owner"
    assert asyncio.run(repository.get_membership(OWNER_ID, organization.id)) == "owner"


def test_list_for_user_excludes_organizations_without_membership() -> None:
    repository = FakeRepository([], {}, {})
    service = OrganizationService(repository)
    owned = asyncio.run(service.create_organization(OWNER_ID, "Hana Studio", "hana-studio"))
    asyncio.run(service.create_organization(OUTSIDER_ID, "Other Studio", "other-studio"))

    organizations = asyncio.run(service.list_for_user(OWNER_ID))

    assert organizations == [owned]


def test_entitlements_reject_a_user_who_is_not_an_organization_member() -> None:
    repository = FakeRepository([], {}, {})
    organization = asyncio.run(
        OrganizationService(repository).create_organization(OWNER_ID, "Hana", "hana")
    )

    with pytest.raises(PermissionError, match="Organization membership required"):
        asyncio.run(
            EntitlementService(repository).get_active_entitlements(OUTSIDER_ID, organization.id)
        )


def test_entitlements_are_empty_when_the_organization_has_no_subscription() -> None:
    repository = FakeRepository([], {}, {})
    organization = asyncio.run(
        OrganizationService(repository).create_organization(OWNER_ID, "Hana", "hana")
    )

    entitlements = asyncio.run(
        EntitlementService(repository).get_active_entitlements(OWNER_ID, organization.id)
    )

    assert entitlements.organization_id == organization.id
    assert entitlements.plan_code is None
    assert entitlements.features == []


def test_basic_subscription_returns_its_feature_codes_while_active() -> None:
    from business_assistant_server.ports.repositories import SubscriptionSummary

    repository = FakeRepository([], {}, {})
    organization = asyncio.run(
        OrganizationService(repository).create_organization(OWNER_ID, "Hana", "hana")
    )
    repository.subscriptions[organization.id] = SubscriptionSummary(
        organization_id=organization.id,
        plan_code="BASIC",
        status="active",
        ends_at=datetime.now(UTC) + timedelta(days=1),
        features=["dashboard.basic", "crm.basic"],
    )

    entitlements = asyncio.run(
        EntitlementService(repository).get_active_entitlements(OWNER_ID, organization.id)
    )

    assert entitlements.plan_code == "BASIC"
    assert entitlements.features == ["crm.basic", "dashboard.basic"]
