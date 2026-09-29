"""Review and immutable handoff of actual treatment charges; no payment side effects."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, StrictBool, field_validator

from business_assistant_server.adapters.supabase_treatment_sale_drafts import (
    SupabaseTreatmentSaleDraftRepository,
    TreatmentSaleDraft,
    TreatmentSaleDraftPreview,
    TreatmentSaleDraftRepository,
    TreatmentSaleValues,
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
    prefix="/organizations/{organization_id}",
    tags=["treatment-sale-drafts"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("finance.basic")),
        Depends(require_feature("document.template")),
        Depends(require_document_member),
    ],
)
_SCOPED = "/customers/{customer_id}/treatments/{treatment_id}/sale-draft"


class TreatmentSaleDraftPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    values: TreatmentSaleValues


class TreatmentSaleDraftCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_preview: TreatmentSaleDraftPreview
    confirmed: StrictBool

    @field_validator("confirmed")
    @classmethod
    def must_confirm(cls, value: bool) -> bool:
        if not value:
            raise ValueError("confirmation is required")
        return value


def get_treatment_sale_draft_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> TreatmentSaleDraftRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Sale draft service unavailable")
    return SupabaseTreatmentSaleDraftRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


@contextmanager
def _safe_errors() -> Iterator[None]:
    try:
        yield
    except RepositoryConflictError:
        raise HTTPException(409, "Preview changed or draft already exists; review again") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Customer, treatment or document not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Sale draft access permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid sale draft request") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Sale draft service unavailable") from None


@router.post(_SCOPED + "/preview", response_model=TreatmentSaleDraftPreview)
async def preview_treatment_sale_draft(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentSaleDraftPreviewRequest,
    repository: Annotated[
        TreatmentSaleDraftRepository, Depends(get_treatment_sale_draft_repository)
    ],
) -> TreatmentSaleDraftPreview:
    with _safe_errors():
        return await repository.preview(
            organization_id, customer_id, treatment_id, request.values.model_dump(mode="json")
        )


@router.post(
    _SCOPED,
    response_model=TreatmentSaleDraft,
    status_code=201,
    dependencies=[Depends(require_document_management_role)],
)
async def create_treatment_sale_draft(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentSaleDraftCreateRequest,
    repository: Annotated[
        TreatmentSaleDraftRepository, Depends(get_treatment_sale_draft_repository)
    ],
) -> TreatmentSaleDraft:
    with _safe_errors():
        return await repository.create(
            organization_id,
            customer_id,
            treatment_id,
            request.operation_id,
            request.expected_preview.model_dump(mode="json"),
            request.confirmed,
        )


@router.get(_SCOPED, response_model=list[TreatmentSaleDraft])
async def list_scoped_treatment_sale_drafts(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    repository: Annotated[
        TreatmentSaleDraftRepository, Depends(get_treatment_sale_draft_repository)
    ],
) -> list[TreatmentSaleDraft]:
    with _safe_errors():
        return await repository.list_drafts(organization_id, customer_id, treatment_id)


@router.get("/treatment-sale-drafts", response_model=list[TreatmentSaleDraft])
async def list_treatment_sale_drafts(
    organization_id: UUID,
    repository: Annotated[
        TreatmentSaleDraftRepository, Depends(get_treatment_sale_draft_repository)
    ],
) -> list[TreatmentSaleDraft]:
    with _safe_errors():
        return await repository.list_drafts(organization_id)
