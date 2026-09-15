from uuid import UUID

from business_assistant_server.ports.repositories import (
    MemberSummary,
    OrganizationRepository,
    OrganizationSummary,
)


class OrganizationService:
    def __init__(self, repository: OrganizationRepository) -> None:
        self._repository = repository

    async def create_organization(self, user_id: UUID, name: str, slug: str) -> OrganizationSummary:
        """Create an organization; its repository establishes the creator as owner."""
        return await self._repository.create_organization(user_id, name, slug)

    async def list_for_user(self, user_id: UUID) -> list[OrganizationSummary]:
        return await self._repository.list_organizations_for_user(user_id)

    async def list_members(self, user_id: UUID, organization_id: UUID) -> list[MemberSummary]:
        organization = await self._repository.get_organization(organization_id)
        if organization is None:
            raise LookupError("Organization not found")
        role = await self._repository.get_membership(user_id, organization_id)
        if role not in {"owner", "admin"}:
            raise PermissionError("Organization management permission required")
        return await self._repository.list_members(organization_id)
