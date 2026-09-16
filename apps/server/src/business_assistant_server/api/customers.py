from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from business_assistant_server.api.entitlements import (
    get_organization_repository,
    require_feature,
)
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    CustomerRepository,
    CustomerSummary,
    OrganizationRepository,
    RepositoryUnavailableError,
)

router = APIRouter()


class CustomerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    email: str | None = None
    phone: str | None = None
    notes: str = ""

    @field_validator("name")
    @classmethod
    def name_is_present(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("name must be between 1 and 200 characters")
        return value

    @field_validator("email")
    @classmethod
    def email_is_valid(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        if "@" not in value or len(value) > 320:
            raise ValueError("email must be valid")
        return value

    @field_validator("phone")
    @classmethod
    def phone_is_valid(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        if len(value) > 50:
            raise ValueError("phone must be at most 50 characters")
        return value

    @field_validator("notes")
    @classmethod
    def notes_are_bounded(cls, value: str) -> str:
        if len(value) > 5000:
            raise ValueError("notes must be at most 5000 characters")
        return value


class CustomerUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    email: str | None = None
    phone: str | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def name_is_present(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("name must not be null")
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("name must be between 1 and 200 characters")
        return value

    @field_validator("email")
    @classmethod
    def email_is_valid(cls, value: str | None) -> str | None:
        return CustomerCreateRequest.email_is_valid(value)

    @field_validator("phone")
    @classmethod
    def phone_is_valid(cls, value: str | None) -> str | None:
        return CustomerCreateRequest.phone_is_valid(value)

    @field_validator("notes")
    @classmethod
    def notes_are_bounded(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("notes must not be null")
        if len(value) > 5000:
            raise ValueError("notes must be at most 5000 characters")
        return value

    @model_validator(mode="after")
    def has_update(self) -> "CustomerUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("at least one customer field is required")
        return self


class CustomerResponseModel(BaseModel):
    id: UUID
    organization_id: UUID
    name: str
    email: str | None
    phone: str | None
    notes: str


def get_customer_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> CustomerRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Customer service unavailable",
        )
    from business_assistant_server.adapters.supabase_customers import SupabaseCustomerRepository

    return SupabaseCustomerRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _customer_response(customer: CustomerSummary) -> CustomerResponseModel:
    return CustomerResponseModel(
        id=customer.id,
        organization_id=customer.organization_id,
        name=customer.name,
        email=customer.email,
        phone=customer.phone,
        notes=customer.notes,
    )


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Customer service unavailable"
    )


async def require_customer_management_role(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    organization_repository: Annotated[
        OrganizationRepository, Depends(get_organization_repository)
    ],
) -> None:
    try:
        role = await organization_repository.get_membership(current_user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if role not in {"owner", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Customer management permission required",
        )


@router.get(
    "/organizations/{organization_id}/customers", response_model=list[CustomerResponseModel]
)
async def list_customers(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[CustomerRepository, Depends(get_customer_repository)],
) -> list[CustomerResponseModel]:
    try:
        return [
            _customer_response(item) for item in await repository.list_customers(organization_id)
        ]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/customers",
    response_model=CustomerResponseModel,
    status_code=status.HTTP_201_CREATED,
)
async def create_customer(
    organization_id: UUID,
    request: CustomerCreateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerRepository, Depends(get_customer_repository)],
) -> CustomerResponseModel:
    try:
        customer = await repository.create_customer(
            organization_id, request.name, request.email, request.phone, request.notes
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return _customer_response(customer)


@router.patch(
    "/organizations/{organization_id}/customers/{customer_id}", response_model=CustomerResponseModel
)
async def update_customer(
    organization_id: UUID,
    customer_id: UUID,
    request: CustomerUpdateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerRepository, Depends(get_customer_repository)],
) -> CustomerResponseModel:
    values = {
        key: value
        for key, value in request.model_dump(exclude_unset=True).items()
        if key in {"name", "email", "phone", "notes"}
    }
    try:
        customer = await repository.update_customer(organization_id, customer_id, values)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if customer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return _customer_response(customer)


@router.delete(
    "/organizations/{organization_id}/customers/{customer_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_customer(
    organization_id: UUID,
    customer_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerRepository, Depends(get_customer_repository)],
) -> None:
    try:
        deleted = await repository.delete_customer(organization_id, customer_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
