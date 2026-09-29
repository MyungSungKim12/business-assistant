"""Preview and issue plain-text treatment snapshots; issuance is not a signature."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict

from business_assistant_server.adapters.supabase_treatment_documents import (
    IssuedTreatmentDocument,
    SupabaseTreatmentDocumentRepository,
    TreatmentDocumentPreview,
    TreatmentDocumentRepository,
)
from business_assistant_server.api.documents import (
    require_document_management_role,
    require_document_member,
)
from business_assistant_server.api.entitlements import require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

router = APIRouter(
    prefix="/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/documents",
    tags=["treatment-documents"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("document.template")),
        Depends(require_document_member),
    ],
)


class TreatmentDocumentPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_id: UUID


class TreatmentDocumentIssueRequest(TreatmentDocumentPreviewRequest):
    operation_id: UUID
    expected_preview: dict[str, object]


def get_treatment_document_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> TreatmentDocumentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Document service unavailable")
    return SupabaseTreatmentDocumentRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


@contextmanager
def _safe_errors() -> Iterator[None]:
    try:
        yield
    except RepositoryConflictError:
        raise HTTPException(409, "Preview changed or operation conflicts; review again") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Customer, treatment or published template not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Document access permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid document request or missing template values") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Document service unavailable") from None


@router.post("/preview", response_model=TreatmentDocumentPreview)
async def preview_treatment_document(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentDocumentPreviewRequest,
    repository: Annotated[TreatmentDocumentRepository, Depends(get_treatment_document_repository)],
) -> TreatmentDocumentPreview:
    with _safe_errors():
        return await repository.preview(
            organization_id, customer_id, treatment_id, request.template_id
        )


@router.post(
    "",
    response_model=IssuedTreatmentDocument,
    status_code=201,
    dependencies=[Depends(require_document_management_role)],
)
async def issue_treatment_document(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentDocumentIssueRequest,
    repository: Annotated[TreatmentDocumentRepository, Depends(get_treatment_document_repository)],
) -> IssuedTreatmentDocument:
    with _safe_errors():
        return await repository.issue(
            organization_id,
            customer_id,
            treatment_id,
            request.template_id,
            request.operation_id,
            request.expected_preview,
        )


@router.get("", response_model=list[IssuedTreatmentDocument])
async def list_issued_treatment_documents(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    repository: Annotated[TreatmentDocumentRepository, Depends(get_treatment_document_repository)],
) -> list[IssuedTreatmentDocument]:
    with _safe_errors():
        return await repository.list_issued(organization_id, customer_id, treatment_id)
