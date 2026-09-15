from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import get_current_user
from business_assistant_server.domain.organizations import OrganizationService
from business_assistant_server.ports.repositories import (
    OrganizationRepository,
    OrganizationSummary,
    RepositoryUnavailableError,
)

router = APIRouter()


class OrganizationCreateRequest(BaseModel):
    name: str
    slug: str


class OrganizationResponseModel(BaseModel):
    id: UUID
    name: str
    slug: str
    role: str


class MemberResponseModel(BaseModel):
    user_id: UUID
    role: str


def _organization_response(organization: OrganizationSummary) -> OrganizationResponseModel:
    return OrganizationResponseModel(
        id=organization.id, name=organization.name, slug=organization.slug, role=organization.role
    )


@router.post(
    "/organizations", response_model=OrganizationResponseModel, status_code=status.HTTP_201_CREATED
)
async def create_organization(
    request: OrganizationCreateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> OrganizationResponseModel:
    try:
        organization = await OrganizationService(repository).create_organization(
            current_user.user_id, request.name, request.slug
        )
    except RepositoryUnavailableError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization service unavailable",
        ) from None
    return _organization_response(organization)


@router.get("/organizations", response_model=list[OrganizationResponseModel])
async def list_organizations(
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> list[OrganizationResponseModel]:
    try:
        organizations = await OrganizationService(repository).list_for_user(current_user.user_id)
    except RepositoryUnavailableError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization service unavailable",
        ) from None
    return [_organization_response(organization) for organization in organizations]


@router.get("/organizations/{organization_id}/members", response_model=list[MemberResponseModel])
async def list_members(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> list[MemberResponseModel]:
    try:
        members = await OrganizationService(repository).list_members(
            current_user.user_id, organization_id
        )
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from None
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from None
    except RepositoryUnavailableError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Organization service unavailable",
        ) from None
    return [MemberResponseModel(user_id=member.user_id, role=member.role) for member in members]
