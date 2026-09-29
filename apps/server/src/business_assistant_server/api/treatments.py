from dataclasses import asdict
from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

from business_assistant_server.api.customers import require_customer_management_role
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
    TreatmentPhotoSummary,
    TreatmentRepository,
    TreatmentSummary,
)

router = APIRouter()


class TreatmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    treatment_date: date
    treatment_name: str = Field(min_length=1, max_length=200)
    category: str = Field(default="", max_length=100)
    practitioner: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=10000)
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    next_visit_date: date | None = None

    @field_serializer("amount", when_used="json")
    def serialize_amount(self, value: Decimal | None) -> str | None:
        return format(value, ".2f") if value is not None else None

    @field_validator("treatment_name", "category", "practitioner", mode="before")
    @classmethod
    def trim_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("treatment_date", "next_visit_date", mode="before")
    @classmethod
    def iso_date(cls, value: object) -> object:
        if value is None:
            return value
        if not isinstance(value, str) or len(value) != 10:
            raise ValueError("Expected YYYY-MM-DD")
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("Expected YYYY-MM-DD")
        return value

    @model_validator(mode="after")
    def next_visit_not_before_treatment(self) -> "TreatmentRequest":
        if self.next_visit_date and self.next_visit_date < self.treatment_date:
            raise ValueError("Next visit cannot be before the treatment date")
        return self


class TreatmentUpdateRequest(TreatmentRequest):
    expected_version: int | None = Field(default=None, ge=1)
    operation_id: UUID | None = None


class CautionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    allergies: str
    skin_type: str | None
    concerns: list[str]


class ConsultationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    goal: str = Field(max_length=2000)
    plan: str = Field(max_length=5000)
    acknowledge_cautions: bool
    expected_cautions: CautionsRequest


class TreatmentMutationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["edit", "correct", "consult", "start", "complete", "cancel"]
    expected_version: int = Field(ge=1)
    operation_id: UUID
    reason: str = Field(default="", max_length=2000)
    values: TreatmentRequest | ConsultationRequest | None = None

    @model_validator(mode="after")
    def check_action(self) -> "TreatmentMutationRequest":
        self.reason = self.reason.strip()
        if self.action in {"correct", "cancel"} and not self.reason:
            raise ValueError("Reason is required")
        if self.action in {"edit", "correct"}:
            if not isinstance(self.values, TreatmentRequest):
                raise ValueError("Edit/correct require treatment values")
        elif self.action == "consult":
            if not isinstance(self.values, ConsultationRequest):
                raise ValueError("Consult requires consultation values")
        elif self.values is not None:
            raise ValueError("Transitions do not accept values")
        return self


class TreatmentEventResponse(BaseModel):
    id: UUID
    actor_id: UUID
    action: str
    reason: str
    occurred_at: str
    before_data: dict[str, object]
    after_data: dict[str, object]


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
    status: str
    version: int
    started_at: str | None
    ended_at: str | None
    consultation_goal: str = ""
    consultation_plan: str = ""
    cautions_snapshot: dict[str, object] = Field(default_factory=dict)
    cautions_acknowledged_by: UUID | None = None
    cautions_acknowledged_at: str | None = None


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
        status=item.status,
        version=item.version,
        started_at=item.started_at,
        ended_at=item.ended_at,
        consultation_goal=item.consultation_goal,
        consultation_plan=item.consultation_plan,
        cautions_snapshot=item.cautions_snapshot,
        cautions_acknowledged_by=item.cautions_acknowledged_by,
        cautions_acknowledged_at=item.cautions_acknowledged_at,
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
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
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
            await repository.create_treatment(
                organization_id, customer_id, request.model_dump(mode="json")
            )
        )
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.patch(
    "/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}",
    response_model=TreatmentResponse,
)
async def update_treatment(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentUpdateRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> TreatmentResponse:
    if request.expected_version is None:
        raise HTTPException(status_code=409, detail="Refresh record and provide expected_version")
    try:
        item = await repository.update_treatment(
            organization_id, customer_id, treatment_id, request.model_dump(mode="json")
        )
        if item is None:
            raise HTTPException(status_code=404, detail="Treatment not found")
        return _treatment_response(item)
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
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
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
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
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
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
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.post(
    "/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/mutations",
    response_model=TreatmentResponse,
)
async def mutate_treatment(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    request: TreatmentMutationRequest,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    ___: Annotated[None, Depends(require_customer_management_role)],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> TreatmentResponse:
    try:
        item = await repository.mutate_treatment(
            organization_id, customer_id, treatment_id, request.model_dump(mode="json")
        )
        return _treatment_response(item)
    except RepositoryConflictError:
        raise HTTPException(
            status_code=409, detail="Record changed or transition not allowed"
        ) from None
    except RepositoryNotFoundError:
        raise HTTPException(status_code=404, detail="Treatment not found") from None
    except RepositoryPermissionError:
        raise HTTPException(status_code=403, detail="Treatment write not allowed") from None
    except RepositoryValidationError:
        raise HTTPException(status_code=422, detail="Invalid treatment values") from None
    except RepositoryUnavailableError:
        raise _unavailable() from None


@router.get(
    "/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/events",
    response_model=list[TreatmentEventResponse],
)
async def list_treatment_events(
    organization_id: UUID,
    customer_id: UUID,
    treatment_id: UUID,
    _: Annotated[AuthUser, Depends(get_current_user)],
    __: Annotated[None, Depends(require_feature("crm.basic"))],
    repository: Annotated[TreatmentRepository, Depends(get_treatment_repository)],
) -> list[TreatmentEventResponse]:
    try:
        return [
            TreatmentEventResponse(**asdict(event))
            for event in await repository.list_treatment_events(
                organization_id, customer_id, treatment_id
            )
        ]
    except RepositoryUnavailableError:
        raise _unavailable() from None
