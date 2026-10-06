# ruff: noqa: E501

import logging
import re
from typing import Annotated
from uuid import UUID, uuid4

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator

from business_assistant_server.api.customers import require_customer_management_role
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    CustomerPhotoRepository,
    CustomerPhotoSummary,
    RepositoryUnavailableError,
)
from business_assistant_server.ports.storage import StoragePort

router = APIRouter()
logger = logging.getLogger(__name__)
MAX_PHOTO_SIZE = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
# Supabase Storage object keys are kept ASCII-safe. The original filename is
# still stored in metadata and shown to the user.
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class PhotoUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original_name: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int
    caption: str = Field(default="", max_length=500)

    @field_validator("content_type")
    @classmethod
    def valid_type(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in ALLOWED_TYPES:
            raise ValueError("Only JPEG, PNG, and WebP images are supported")
        return value

    @field_validator("size_bytes")
    @classmethod
    def valid_size(cls, value: int) -> int:
        if value <= 0 or value > MAX_PHOTO_SIZE:
            raise ValueError("Photo must be between 1 byte and 10 MB")
        return value

    @field_validator("original_name", "caption")
    @classmethod
    def trim_text(cls, value: str) -> str:
        return value.strip()


class PhotoResponse(BaseModel):
    id: UUID
    organization_id: UUID
    customer_id: UUID
    original_name: str
    storage_path: str
    content_type: str
    size_bytes: int
    caption: str
    created_at: str


class SignedPhotoResponse(BaseModel):
    photo: PhotoResponse
    signed_url: str
    expires_in: int


def _repo(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> CustomerPhotoRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Customer photo service unavailable")
    from business_assistant_server.adapters.supabase_customer_photos import (
        SupabaseCustomerPhotoRepository,
    )

    return SupabaseCustomerPhotoRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _storage(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> StoragePort:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Customer photo service unavailable")
    from business_assistant_server.adapters.supabase_files import SupabaseStorageAdapter

    return SupabaseStorageAdapter(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _response(item: CustomerPhotoSummary) -> PhotoResponse:
    return PhotoResponse(
        id=item.id,
        organization_id=item.organization_id,
        customer_id=item.customer_id,
        original_name=item.original_name,
        storage_path=item.storage_path,
        content_type=item.content_type,
        size_bytes=item.size_bytes,
        caption=item.caption,
        created_at=item.created_at,
    )


def _safe_name(name: str) -> str:
    return (SAFE_NAME.sub("-", name).strip(".-") or "photo")[:180]


@router.get(
    "/organizations/{organization_id}/customers/{customer_id}/photos",
    response_model=list[PhotoResponse],
)
async def list_photos(
    organization_id: UUID,
    customer_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[CustomerPhotoRepository, Depends(_repo)],
) -> list[PhotoResponse]:
    try:
        return [
            _response(item) for item in await repository.list_photos(organization_id, customer_id)
        ]
    except RepositoryUnavailableError:
        raise HTTPException(503, "Customer photo service unavailable") from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/photos/upload-url",
    response_model=SignedPhotoResponse,
    status_code=201,
)
async def create_upload_url(
    organization_id: UUID,
    customer_id: UUID,
    request: PhotoUploadRequest,
    user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("crm.basic"))],
    __: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerPhotoRepository, Depends(_repo)],
    storage: Annotated[StoragePort, Depends(_storage)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SignedPhotoResponse:
    photo_id = uuid4()
    created = False
    path = f"{organization_id}/{customer_id}/{photo_id}-{_safe_name(request.original_name)}"
    try:
        photo = await repository.create_photo(
            organization_id,
            customer_id,
            user.user_id,
            {
                "id": str(photo_id),
                "storage_path": path,
                "original_name": request.original_name,
                "content_type": request.content_type,
                "size_bytes": request.size_bytes,
                "caption": request.caption,
            },
        )
        created = True
        signed_url = await storage.create_upload_url(settings.file_bucket, path)
        return SignedPhotoResponse(photo=_response(photo), signed_url=signed_url, expires_in=600)
    except RepositoryUnavailableError:
        if created:
            try:
                await repository.archive_photo(organization_id, customer_id, photo_id)
            except RepositoryUnavailableError:
                logger.exception("Failed to archive incomplete photo: photo_id=%s", photo_id)
        logger.exception("Customer photo upload preparation failed: customer_id=%s", customer_id)
        raise HTTPException(503, "Customer photo service unavailable") from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/photos/{photo_id}/download-url",
    response_model=SignedPhotoResponse,
)
async def create_download_url(
    organization_id: UUID,
    customer_id: UUID,
    photo_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[CustomerPhotoRepository, Depends(_repo)],
    storage: Annotated[StoragePort, Depends(_storage)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SignedPhotoResponse:
    try:
        photo = await repository.get_photo(organization_id, customer_id, photo_id)
        if photo is None:
            raise HTTPException(404, "Customer photo not found")
        signed_url = await storage.create_download_url(
            settings.file_bucket, photo.storage_path, 300
        )
        return SignedPhotoResponse(photo=_response(photo), signed_url=signed_url, expires_in=300)
    except RepositoryUnavailableError:
        raise HTTPException(503, "Customer photo service unavailable") from None


@router.delete(
    "/organizations/{organization_id}/customers/{customer_id}/photos/{photo_id}",
    response_model=PhotoResponse,
)
async def archive_photo(
    organization_id: UUID,
    customer_id: UUID,
    photo_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[CustomerPhotoRepository, Depends(_repo)],
) -> PhotoResponse:
    try:
        photo = await repository.archive_photo(organization_id, customer_id, photo_id)
        if photo is None:
            raise HTTPException(404, "Customer photo not found")
        return _response(photo)
    except RepositoryUnavailableError:
        raise HTTPException(503, "Customer photo service unavailable") from None
