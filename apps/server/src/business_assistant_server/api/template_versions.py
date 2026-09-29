"""Atomic document template lifecycle; publication snapshots are read-only."""

from typing import Annotated, Literal
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from business_assistant_server.api.documents import (
    DocumentTemplateResponse,
    _template_response,
    get_document_repository,
    require_document_management_role,
    require_document_member,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.dependencies.auth import get_current_user
from business_assistant_server.ports.repositories import (
    DocumentRepository,
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

router = APIRouter(tags=["document-templates"])


class TemplateFields(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(max_length=100_000)
    content: str = Field(max_length=100_000)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name is required")
        return value.strip()


class TemplateMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    action: Literal["create", "save", "publish", "revise", "retire"]
    values: TemplateFields | None = None

    @model_validator(mode="after")
    def valid_action(self) -> "TemplateMutation":
        if (self.action in {"create", "save"}) != (self.values is not None):
            raise ValueError("create/save require fields; transitions prohibit fields")
        if (self.action == "create") != (self.expected_revision == 0):
            raise ValueError("only create uses revision zero")
        return self


class TemplateVersion(BaseModel):
    template_id: UUID
    organization_id: UUID
    version: int
    name: str
    description: str
    content: str
    published_by: UUID
    published_at: str


@router.post(
    "/organizations/{organization_id}/document-templates/{template_id}/mutations",
    response_model=DocumentTemplateResponse,
)
async def mutate_template(
    organization_id: UUID,
    template_id: UUID,
    request: TemplateMutation,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    ___: Annotated[None, Depends(require_document_management_role)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> DocumentTemplateResponse:
    values = request.model_dump(mode="json")
    values["values"] = request.values.model_dump() if request.values else {}
    try:
        return _template_response(
            await repository.mutate_template(organization_id, template_id, values)
        )
    except RepositoryConflictError:
        raise HTTPException(409, "Template changed or transition is not allowed") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Template not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Template management permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid template fields or empty publication") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Template service unavailable") from None


@router.get(
    "/organizations/{organization_id}/document-templates/{template_id}/versions",
    response_model=list[TemplateVersion],
)
async def list_versions(
    organization_id: UUID,
    template_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("document.template"))],
    ___: Annotated[None, Depends(require_document_member)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> list[TemplateVersion]:
    try:
        return [
            TemplateVersion.model_validate(row)
            for row in await repository.list_template_versions(organization_id, template_id)
        ]
    except RepositoryUnavailableError:
        raise HTTPException(503, "Template service unavailable") from None
