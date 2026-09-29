"""Record staff-witnessed signatures and external delivery/withdrawal facts."""

from collections.abc import Iterator
from contextlib import contextmanager
from math import isfinite
from typing import Annotated, Literal, Self
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from business_assistant_server.adapters.supabase_document_consent import (
    DocumentConsentEvent,
    DocumentConsentRepository,
    SupabaseDocumentConsentRepository,
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
    prefix=(
        "/organizations/{organization_id}/customers/{customer_id}"
        "/treatments/{treatment_id}/documents/{document_id}/events"
    ),
    tags=["document-consent"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature("crm.basic")),
        Depends(require_feature("document.template")),
        Depends(require_document_member),
    ],
)


class ConfirmedValues(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value: object) -> object:
        if value is not True:
            raise ValueError("Explicit confirmation required")
        return value


class SignatureValues(ConfirmedValues):
    signer_name: str = Field(min_length=1, max_length=100)
    strokes: list[list[list[float]]]

    @field_validator("signer_name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Signer name required")
        return value

    @field_validator("strokes", mode="before")
    @classmethod
    def normalized_drawing(cls, value: object) -> object:
        if not isinstance(value, list) or not 1 <= len(value) <= 50:
            raise ValueError("Between 1 and 50 strokes required")
        total = 0
        distinct: set[tuple[float, float]] = set()
        for stroke in value:
            if not isinstance(stroke, list) or not 1 <= len(stroke) <= 500:
                raise ValueError("Between 1 and 500 points per stroke required")
            total += len(stroke)
            if total > 5000:
                raise ValueError("At most 5000 points allowed")
            for point in stroke:
                if not isinstance(point, list) or len(point) != 2:
                    raise ValueError("Each point requires two coordinates")
                for coordinate in point:
                    if (
                        type(coordinate) not in (int, float)
                        or not 0 <= coordinate <= 1
                        or not isfinite(coordinate)
                    ):
                        raise ValueError("Coordinates must be finite numbers between 0 and 1")
                distinct.add((point[0], point[1]))
        if len(distinct) < 2:
            raise ValueError("At least two distinct points required")
        return value


class DeliveryValues(ConfirmedValues):
    method: Literal["paper", "email", "sms", "other"]
    recipient: str = Field(min_length=1, max_length=200)
    reference: str = Field(max_length=500)
    note: str = Field(max_length=2000)

    @field_validator("recipient")
    @classmethod
    def nonblank_recipient(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Recipient required")
        return value


class RevocationValues(ConfirmedValues):
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Withdrawal reason required")
        return value


class DocumentConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(strict=True, ge=0, le=2147483647)
    operation_id: UUID
    action: Literal["sign", "deliver", "revoke"]
    values: dict[str, object]

    @model_validator(mode="after")
    def action_values(self) -> Self:
        models = {"sign": SignatureValues, "deliver": DeliveryValues, "revoke": RevocationValues}
        models[self.action].model_validate(self.values)
        return self


def get_document_consent_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> DocumentConsentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Document consent service unavailable")
    return SupabaseDocumentConsentRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


@contextmanager
def _safe_errors() -> Iterator[None]:
    try:
        yield
    except RepositoryConflictError:
        raise HTTPException(409, "Document state changed or operation conflicts; reload") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Issued document not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Document access permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid document consent request") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Document consent service unavailable") from None


@router.get("", response_model=list[DocumentConsentEvent])
async def list_document_consent_events(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    document_id: UUID,
    repository: Annotated[DocumentConsentRepository, Depends(get_document_consent_repository)],
) -> list[DocumentConsentEvent]:
    with _safe_errors():
        return await repository.list_events(organization_id, customer_id, treatment_id, document_id)


@router.post(
    "",
    response_model=DocumentConsentEvent,
    status_code=201,
    dependencies=[Depends(require_document_management_role)],
)
async def record_document_consent_event(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    document_id: UUID,
    request: DocumentConsentRequest,
    repository: Annotated[DocumentConsentRepository, Depends(get_document_consent_repository)],
) -> DocumentConsentEvent:
    with _safe_errors():
        return await repository.record_event(
            organization_id,
            customer_id,
            treatment_id,
            document_id,
            request.expected_revision,
            request.operation_id,
            request.action,
            request.values,
        )
