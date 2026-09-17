from decimal import Decimal
from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field

from business_assistant_server.api.customers import require_customer_management_role
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    RepositoryUnavailableError,
    TreatmentPhotoSummary,
    TreatmentRepository,
    TreatmentSummary,
)

router = APIRouter()


class TreatmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    treatment_date: str
    treatment_name: str = Field(min_length=1, max_length=200)
    category: str = ""
    practitioner: str = ""
    notes: str = ""
    amount: Decimal | None = Field(default=None, ge=0)
    next_visit_date: str | None = None


class PhotoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    treatment_id: UUID
    storage_path: str = Field(min_length=1, max_length=1000)
    thumbnail_path: str | None = None
    content_type: str = "image/jpeg"
    caption: str = ""
    sort_order: int = Field(default=0, ge=0)
    taken_at: str | None = None


class TreatmentResponse(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_date: str
    treatment_name: str
    category: str
    practitioner: str
    notes: str
    amount: Decimal | None
    next_visit_date: str | None


class PhotoResponse(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_id: UUID
    storage_path: str
    thumbnail_path: str | None
    content_type: str
    caption: str
    sort_order: int
    taken_at: str | None


def get_treatment_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> TreatmentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(status_code=503, detail="Treatment service unavailable")
    from business_assistant_server.adapters.supabase_treatments import SupabaseTreatmentRepository

    return SupabaseTreatmentRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="Treatment service unavailable")


def _treatment_response(item: TreatmentSummary) -> TreatmentResponse:
    return TreatmentResponse(
        id=item.id,
        organization_id=item.organization_id,
        customer_id=item.customer_id,
        treatment_date=item.treatment_date,
        treatment_name=item.treatment_name,
        category=item.category,
        practitioner=item.practitioner,
        notes=item.notes,
        amount=item.amount,
        next_visit_date=item.next_visit_date,
    )


def _photo_response(item: TreatmentPhotoSummary) -> PhotoResponse:
    return PhotoResponse(
        id=item.id,
        organization_id=item.organization_id,
        customer_id=item.customer_id,
        treatment_id=item.treatment_id,
        storage_path=item.storage_path,
        thumbnail_path=item.thumbnail_path,
        content_type=item.content_type,
        caption=item.caption,
        sort_order=item.sort_order,
        taken_at=item.taken_at,
    )


@router.get(
    "/organizations/{organization_id}/customers/{customer_id}/treatments",
    response_model=list[TreatmentResponse],
)
async def list_treatments(
    organization_id: UUID,
    customer_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> list[TreatmentResponse]:
    try:
        return [
            _treatment_response(item)
            for item in await repository.list_treatments(organization_id, customer_id)
        ]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/treatments",
    response_model=TreatmentResponse,
    status_code=201,
)
async def create_treatment(
    organization_id: UUID,
    customer_id: UUID,
    request: TreatmentRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> TreatmentResponse:
    try:
        return _treatment_response(
            await repository.create_treatment(organization_id, customer_id, request.model_dump())
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.get(
    "/organizations/{organization_id}/customers/{customer_id}/treatment-photos",
    response_model=list[PhotoResponse],
)
async def list_photos(
    organization_id: UUID,
    customer_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
    treatment_id: UUID | None = None,
) -> list[PhotoResponse]:
    try:
        return [
            _photo_response(item)
            for item in await repository.list_photos(organization_id, customer_id, treatment_id)
        ]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/treatment-photos",
    response_model=PhotoResponse,
    status_code=201,
)
async def create_photo(
    organization_id: UUID,
    customer_id: UUID,
    request: PhotoRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> PhotoResponse:
    try:
        return _photo_response(
            await repository.create_photo(organization_id, customer_id, request.model_dump())
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.delete(
    "/organizations/{organization_id}/customers/{customer_id}/treatment-photos/{photo_id}",
    status_code=204,
)
async def delete_photo(
    organization_id: UUID,
    customer_id: UUID,
    photo_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> None:
    try:
        if not await repository.delete_photo(organization_id, customer_id, photo_id):
            raise HTTPException(status_code=404, detail="Treatment photo not found")
    except RepositoryUnavailableError:
        raise _unavailable() from None
