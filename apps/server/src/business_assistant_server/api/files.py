import re
from typing import Annotated
from uuid import UUID, uuid4

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Query, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator

from business_assistant_server.api.entitlements import get_organization_repository, require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    FileRepository,
    FileSummary,
    OrganizationRepository,
    RepositoryUnavailableError,
)
from business_assistant_server.ports.storage import StoragePort

router = APIRouter()
MAX_FILE_SIZE = 50 * 1024 * 1024
_SAFE_NAME = re.compile(r"[^\w.가-힣-]+", re.UNICODE)


class FileUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original_name: str
    content_type: str
    size_bytes: int

    @field_validator("original_name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 255:
            raise ValueError("original_name must be between 1 and 255 characters")
        return value

    @field_validator("content_type")
    @classmethod
    def valid_type(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 255:
            raise ValueError("content_type must be between 1 and 255 characters")
        return value

    @field_validator("size_bytes")
    @classmethod
    def valid_size(cls, value: int) -> int:
        if value < 0 or value > MAX_FILE_SIZE:
            raise ValueError("size_bytes must be between 0 and 52428800")
        return value


class FileResponse(BaseModel):
    id: UUID
    organization_id: UUID
    uploaded_by: UUID
    original_name: str
    content_type: str
    size_bytes: int
    is_archived: bool
    created_at: str
    updated_at: str


class SignedUrlResponse(BaseModel):
    file: FileResponse
    signed_url: str
    expires_in: int


def _repo(settings: Settings, authorization: HTTPAuthorizationCredentials | None) -> FileRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "File service unavailable")
    from business_assistant_server.adapters.supabase_files import SupabaseFileRepository

    return SupabaseFileRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def _storage(settings: Settings, authorization: HTTPAuthorizationCredentials | None) -> StoragePort:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "File service unavailable")
    from business_assistant_server.adapters.supabase_files import SupabaseStorageAdapter

    return SupabaseStorageAdapter(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


def get_file_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> FileRepository:
    return _repo(settings, authorization)


def get_file_storage(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> StoragePort:
    return _storage(settings, authorization)


async def _require_member(
    organization_id: UUID, user: AuthUser, organizations: OrganizationRepository
) -> str:
    try:
        role = await organizations.get_membership(user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise HTTPException(503, "File service unavailable") from None
    if role not in {"owner", "admin", "member"}:
        raise HTTPException(403, "Organization membership required")
    return role


def _response(item: FileSummary) -> FileResponse:
    return FileResponse(
        id=item.id,
        organization_id=item.organization_id,
        uploaded_by=item.uploaded_by,
        original_name=item.original_name,
        content_type=item.content_type,
        size_bytes=item.size_bytes,
        is_archived=item.is_archived,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _safe_filename(name: str) -> str:
    cleaned = _SAFE_NAME.sub("-", name).strip(".-") or "file"
    return cleaned[:180]


@router.get("/organizations/{organization_id}/files", response_model=list[FileResponse])
async def list_files(
    organization_id: UUID,
    user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("files.basic"))],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    repository: Annotated[FileRepository, Depends(get_file_repository)],
    include_archived: bool = Query(False),
) -> list[FileResponse]:
    await _require_member(organization_id, user, organizations)
    try:
        return [
            _response(item)
            for item in await repository.list_files(organization_id, include_archived)
        ]
    except RepositoryUnavailableError:
        raise HTTPException(503, "File service unavailable") from None


@router.post(
    "/organizations/{organization_id}/files/upload-url",
    response_model=SignedUrlResponse,
    status_code=201,
)
async def create_upload_url(
    organization_id: UUID,
    request: FileUploadRequest,
    user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("files.basic"))],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    repository: Annotated[FileRepository, Depends(get_file_repository)],
    storage: Annotated[StoragePort, Depends(get_file_storage)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SignedUrlResponse:
    await _require_member(organization_id, user, organizations)
    file_id = uuid4()
    path = f"{organization_id}/{file_id}-{_safe_filename(request.original_name)}"
    try:
        item = await repository.create_file(
            organization_id,
            user.user_id,
            {
                "id": str(file_id),
                "storage_path": path,
                "original_name": request.original_name,
                "content_type": request.content_type,
                "size_bytes": request.size_bytes,
            },
        )
        url = await storage.create_upload_url(settings.file_bucket, path)
    except RepositoryUnavailableError:
        raise HTTPException(503, "File service unavailable") from None
    return SignedUrlResponse(file=_response(item), signed_url=url, expires_in=600)


@router.post(
    "/organizations/{organization_id}/files/{file_id}/download-url",
    response_model=SignedUrlResponse,
)
async def create_download_url(
    organization_id: UUID,
    file_id: UUID,
    user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("files.basic"))],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    repository: Annotated[FileRepository, Depends(get_file_repository)],
    storage: Annotated[StoragePort, Depends(get_file_storage)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SignedUrlResponse:
    await _require_member(organization_id, user, organizations)
    try:
        item = await repository.get_file(organization_id, file_id)
        if item is None or item.is_archived:
            raise HTTPException(404, "File not found")
        url = await storage.create_download_url(settings.file_bucket, item.storage_path, 300)
    except RepositoryUnavailableError:
        raise HTTPException(503, "File service unavailable") from None
    return SignedUrlResponse(file=_response(item), signed_url=url, expires_in=300)


@router.delete("/organizations/{organization_id}/files/{file_id}", response_model=FileResponse)
async def archive_file(
    organization_id: UUID,
    file_id: UUID,
    user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("files.basic"))],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    repository: Annotated[FileRepository, Depends(get_file_repository)],
) -> FileResponse:
    role = await _require_member(organization_id, user, organizations)
    if role not in {"owner", "admin"}:
        raise HTTPException(403, "File management permission required")
    try:
        item = await repository.archive_file(organization_id, file_id)
    except RepositoryUnavailableError:
        raise HTTPException(503, "File service unavailable") from None
    if item is None:
        raise HTTPException(404, "File not found")
    return _response(item)
