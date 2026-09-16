from typing import Annotated
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from business_assistant_server.api.entitlements import get_organization_repository, require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import bearer_scheme, get_current_user, get_settings
from business_assistant_server.ports.repositories import (
    DocumentRepository,
    DocumentSummary,
    DocumentTemplateSummary,
    OrganizationRepository,
    RepositoryUnavailableError,
)

router = APIRouter()
_DOCUMENT_STATUSES = {"draft", "final", "archived"}


class DocumentTemplateCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    content: str = ""
    is_archived: bool = False

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("name must be between 1 and 200 characters")
        return value

    @field_validator("description", "content")
    @classmethod
    def valid_text(cls, value: str) -> str:
        if len(value) > 100_000:
            raise ValueError("text must be at most 100000 characters")
        return value


class DocumentTemplateUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    content: str | None = None
    is_archived: bool | None = None

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("name must not be null")
        return DocumentTemplateCreateRequest.valid_name(value)

    @field_validator("description", "content")
    @classmethod
    def valid_text(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("text must not be null")
        return DocumentTemplateCreateRequest.valid_text(value)

    @field_validator("is_archived")
    @classmethod
    def valid_archived(cls, value: bool | None) -> bool:
        if value is None:
            raise ValueError("is_archived must not be null")
        return value

    @model_validator(mode="after")
    def has_update(self) -> "DocumentTemplateUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("at least one template field is required")
        return self


class DocumentCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    content: str = ""
    template_id: UUID | None = None
    status: str = "draft"

    @field_validator("title")
    @classmethod
    def valid_title(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("title must be between 1 and 200 characters")
        return value

    @field_validator("content")
    @classmethod
    def valid_content(cls, value: str) -> str:
        if len(value) > 100_000:
            raise ValueError("content must be at most 100000 characters")
        return value

    @field_validator("status")
    @classmethod
    def valid_status(cls, value: str) -> str:
        if value not in _DOCUMENT_STATUSES:
            raise ValueError("invalid document status")
        return value


class DocumentUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    content: str | None = None
    template_id: UUID | None = None
    status: str | None = None

    @field_validator("title")
    @classmethod
    def valid_title(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("title must not be null")
        return DocumentCreateRequest.valid_title(value)

    @field_validator("content")
    @classmethod
    def valid_content(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("content must not be null")
        return DocumentCreateRequest.valid_content(value)

    @field_validator("status")
    @classmethod
    def valid_status(cls, value: str | None) -> str:
        if value is None or value not in _DOCUMENT_STATUSES:
            raise ValueError("invalid document status")
        return value

    @model_validator(mode="after")
    def has_update(self) -> "DocumentUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("at least one document field is required")
        return self


class DocumentTemplateResponse(BaseModel):
    id: UUID
    organization_id: UUID
    created_by: UUID
    name: str
    description: str
    content: str
    is_archived: bool
    created_at: str
    updated_at: str


class DocumentResponse(BaseModel):
    id: UUID
    organization_id: UUID
    template_id: UUID | None
    created_by: UUID
    title: str
    content: str
    status: str
    created_at: str
    updated_at: str


def get_document_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> DocumentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Document service unavailable")
    from business_assistant_server.adapters.supabase_documents import SupabaseDocumentRepository

    return SupabaseDocumentRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


async def require_document_management_role(
    organization_id: UUID,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    organization_repository: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> None:
    try:
        role = await organization_repository.get_membership(current_user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if role not in {"owner", "admin"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Document management permission required")


def _unavailable() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Document service unavailable")


def _template_response(item: DocumentTemplateSummary) -> DocumentTemplateResponse:
    return DocumentTemplateResponse(
        id=item.id,
        organization_id=item.organization_id,
        created_by=item.created_by,
        name=item.name,
        description=item.description,
        content=item.content,
        is_archived=item.is_archived,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _document_response(item: DocumentSummary) -> DocumentResponse:
    return DocumentResponse(
        id=item.id,
        organization_id=item.organization_id,
        template_id=item.template_id,
        created_by=item.created_by,
        title=item.title,
        content=item.content,
        status=item.status,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.get(
    "/organizations/{organization_id}/document-templates",
    response_model=list[DocumentTemplateResponse],
)
async def list_document_templates(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> list[DocumentTemplateResponse]:
    try:
        return [_template_response(item) for item in await repository.list_templates(organization_id)]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/document-templates",
    response_model=DocumentTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document_template(
    organization_id: UUID,
    request: DocumentTemplateCreateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("document.template"))],
    __: Annotated[None, Depends(require_document_management_role)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> DocumentTemplateResponse:
    try:
        item = await repository.create_template(
            organization_id, current_user.user_id, request.model_dump(mode="json")
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return _template_response(item)


@router.patch(
    "/organizations/{organization_id}/document-templates/{template_id}",
    response_model=DocumentTemplateResponse,
)
async def update_document_template(
    organization_id: UUID,
    template_id: UUID,
    request: DocumentTemplateUpdateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    ___: Annotated[None, Depends(require_document_management_role)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> DocumentTemplateResponse:
    try:
        item = await repository.update_template(
            organization_id, template_id, request.model_dump(exclude_unset=True, mode="json")
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if item is None:
        raise HTTPException(404, "Document template not found")
    return _template_response(item)


@router.get(
    "/organizations/{organization_id}/documents", response_model=list[DocumentResponse]
)
async def list_documents(
    organization_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> list[DocumentResponse]:
    try:
        return [_document_response(item) for item in await repository.list_documents(organization_id)]
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document(
    organization_id: UUID,
    request: DocumentCreateRequest,
    current_user: Annotated[AuthUser, Depends(get_current_user)],
    _: Annotated[None, Depends(require_feature("document.template"))],
    __: Annotated[None, Depends(require_document_management_role)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> DocumentResponse:
    try:
        item = await repository.create_document(
            organization_id, current_user.user_id, request.model_dump(mode="json")
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    return _document_response(item)


@router.patch(
    "/organizations/{organization_id}/documents/{document_id}",
    response_model=DocumentResponse,
)
async def update_document(
    organization_id: UUID,
    document_id: UUID,
    request: DocumentUpdateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    ___: Annotated[None, Depends(require_document_management_role)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> DocumentResponse:
    try:
        item = await repository.update_document(
            organization_id,
            document_id,
            request.model_dump(exclude_unset=True, mode="json"),
        )
    except RepositoryUnavailableError:
        raise _unavailable() from None
    if item is None:
        raise HTTPException(404, "Document not found")
    return _document_response(item)
