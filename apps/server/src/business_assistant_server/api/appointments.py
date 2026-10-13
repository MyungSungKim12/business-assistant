"""Appointment scheduling and visit handoff."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, time
from typing import Annotated, Literal
from uuid import UUID

from business_assistant_common.auth import AuthUser
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from business_assistant_server.adapters.supabase_appointments import (
    Appointment,
    AppointmentResource,
    AppointmentService,
    AppointmentServiceResourceRequirement,
    AppointmentStaff,
    AppointmentTimeOff,
    ServiceResourceRequirementsResult,
    StaffAvailability,
    SupabaseAppointmentRepository,
    WorkingHoursResult,
)
from business_assistant_server.api.entitlements import get_organization_repository, require_feature
from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    bearer_scheme,
    get_current_user,
    get_settings,
)
from business_assistant_server.ports.repositories import (
    OrganizationRepository,
    RepositoryConflictError,
    RepositoryNotFoundError,
    RepositoryPermissionError,
    RepositoryUnavailableError,
    RepositoryValidationError,
)

router = APIRouter(
    prefix="/organizations/{organization_id}",
    tags=["appointments"],
    dependencies=[Depends(get_current_user), Depends(require_feature("task.basic"))],
)


async def require_member(
    organization_id: UUID,
    user: Annotated[AuthUser, Depends(get_current_user)],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> None:
    try:
        role = await organizations.get_membership(user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise HTTPException(503, "Organization service unavailable") from None
    if role not in {"owner", "admin", "member"}:
        raise HTTPException(403, "Appointment access permission required")


async def require_manager(
    organization_id: UUID,
    user: Annotated[AuthUser, Depends(get_current_user)],
    organizations: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> None:
    try:
        role = await organizations.get_membership(user.user_id, organization_id)
    except RepositoryUnavailableError:
        raise HTTPException(503, "Organization service unavailable") from None
    if role not in {"owner", "admin"}:
        raise HTTPException(403, "Appointment management permission required")


def get_repository(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> SupabaseAppointmentRepository:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    if settings.supabase_url is None or settings.supabase_publishable_key is None:
        raise HTTPException(503, "Appointment service unavailable")
    return SupabaseAppointmentRepository(
        str(settings.supabase_url), settings.supabase_publishable_key, authorization.credentials
    )


Repository = Annotated[SupabaseAppointmentRepository, Depends(get_repository)]


@contextmanager
def safe_errors() -> Iterator[None]:
    try:
        yield
    except RepositoryConflictError:
        raise HTTPException(409, "Appointment conflict; reload and retry") from None
    except RepositoryNotFoundError:
        raise HTTPException(404, "Appointment, customer, staff or service not found") from None
    except RepositoryPermissionError:
        raise HTTPException(403, "Appointment permission required") from None
    except RepositoryValidationError:
        raise HTTPException(422, "Invalid appointment request") from None
    except RepositoryUnavailableError:
        raise HTTPException(503, "Appointment service unavailable") from None


class StaffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120)]

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Staff name is required")
        return value.strip()


class ServiceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=160)]
    duration_minutes: Annotated[int, Field(ge=5, le=480, strict=True)]
    buffer_minutes: Annotated[int, Field(ge=0, le=120, strict=True)] = 0

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Service name is required")
        return value.strip()


class ResourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120)]
    kind: Literal["room", "equipment"]
    operation_id: UUID

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Resource name is required")
        return value.strip()


class ResourceUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120)]
    is_active: bool
    expected_version: Annotated[int, Field(ge=1, strict=True)]
    operation_id: UUID

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Resource name is required")
        return value.strip()


class ResourceRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["room", "equipment"]
    quantity: Annotated[int, Field(ge=1, le=10, strict=True)]


class ResourceRequirementsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requirements: Annotated[list[ResourceRequirement], Field(max_length=2)]
    expected_version: Annotated[int, Field(ge=1, strict=True)]
    operation_id: UUID

    @field_validator("requirements")
    @classmethod
    def unique_kinds(cls, value: list[ResourceRequirement]) -> list[ResourceRequirement]:
        if len({item.kind for item in value}) != len(value):
            raise ValueError("Resource requirement kinds must be unique")
        return value


class WorkingHourRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    weekday: Annotated[int, Field(ge=1, le=7, strict=True)]
    start: time
    end: time

    @model_validator(mode="after")
    def valid_range(self) -> "WorkingHourRequest":
        if self.end <= self.start:
            raise ValueError("Working hour end must follow start")
        return self


class WorkingHoursRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone_name: Annotated[str, Field(min_length=1, max_length=100)] = "Asia/Seoul"
    hours: Annotated[list[WorkingHourRequest], Field(max_length=21)]
    expected_version: Annotated[int, Field(ge=1, strict=True)]
    operation_id: UUID

    @field_validator("timezone_name")
    @classmethod
    def strip_timezone(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Timezone is required")
        return value.strip()


class TimeOffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_at: datetime
    end_at: datetime
    reason: Annotated[str, Field(min_length=1, max_length=1000)]
    operation_id: UUID

    @model_validator(mode="after")
    def valid_period(self) -> "TimeOffRequest":
        if (
            self.start_at.tzinfo is None
            or self.start_at.utcoffset() is None
            or self.end_at.tzinfo is None
            or self.end_at.utcoffset() is None
            or self.end_at <= self.start_at
        ):
            raise ValueError("Time off requires an aware increasing period")
        self.reason = self.reason.strip()
        if not self.reason:
            raise ValueError("Time off reason is required")
        return self


class CancelTimeOffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: Annotated[int, Field(ge=1, strict=True)]
    operation_id: UUID


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_id: UUID
    staff_id: UUID
    service_id: UUID
    start_at: datetime
    source: Literal["manual", "phone", "walk_in", "online"] = "manual"
    expected_version: Annotated[int, Field(ge=1, strict=True)] | None = None
    operation_id: UUID
    resource_ids: Annotated[list[UUID], Field(max_length=20)] = Field(default_factory=list)

    @field_validator("start_at")
    @classmethod
    def aware_start(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Appointment time requires an offset")
        return value

    @field_validator("resource_ids")
    @classmethod
    def unique_resources(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Appointment resources must be unique")
        return value


class TransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_status: Literal["confirmed", "checked_in", "completed", "canceled", "no_show"]
    reason: Annotated[str, Field(max_length=1000)] | None = None
    expected_version: Annotated[int, Field(ge=1, strict=True)]
    operation_id: UUID

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


@router.get(
    "/appointment-staff",
    response_model=list[AppointmentStaff],
    dependencies=[Depends(require_member)],
)
async def list_staff(organization_id: UUID, repository: Repository) -> list[AppointmentStaff]:
    with safe_errors():
        return await repository.list_staff(organization_id)


@router.post(
    "/appointment-staff",
    response_model=AppointmentStaff,
    status_code=201,
    dependencies=[Depends(require_manager)],
)
async def create_staff(
    organization_id: UUID, request: StaffRequest, repository: Repository
) -> AppointmentStaff:
    with safe_errors():
        return await repository.create_staff(organization_id, request.name)


@router.get(
    "/appointment-staff/{staff_id}/availability",
    response_model=StaffAvailability,
    dependencies=[Depends(require_member)],
)
async def get_staff_availability(
    organization_id: UUID, staff_id: UUID, repository: Repository
) -> StaffAvailability:
    with safe_errors():
        return await repository.get_staff_availability(organization_id, staff_id)


@router.put(
    "/appointment-staff/{staff_id}/working-hours",
    response_model=WorkingHoursResult,
    dependencies=[Depends(require_manager)],
)
async def replace_staff_hours(
    organization_id: UUID,
    staff_id: UUID,
    request: WorkingHoursRequest,
    repository: Repository,
) -> WorkingHoursResult:
    with safe_errors():
        return await repository.replace_staff_hours(
            organization_id, staff_id, request.model_dump(mode="json")
        )


@router.post(
    "/appointment-staff/{staff_id}/time-off",
    response_model=AppointmentTimeOff,
    status_code=201,
    dependencies=[Depends(require_manager)],
)
async def create_staff_time_off(
    organization_id: UUID,
    staff_id: UUID,
    request: TimeOffRequest,
    repository: Repository,
) -> AppointmentTimeOff:
    with safe_errors():
        return await repository.create_staff_time_off(
            organization_id, staff_id, request.model_dump(mode="json")
        )


@router.post(
    "/appointment-staff/{staff_id}/time-off/{time_off_id}/cancel",
    response_model=AppointmentTimeOff,
    dependencies=[Depends(require_manager)],
)
async def cancel_staff_time_off(
    organization_id: UUID,
    staff_id: UUID,
    time_off_id: UUID,
    request: CancelTimeOffRequest,
    repository: Repository,
) -> AppointmentTimeOff:
    with safe_errors():
        return await repository.cancel_staff_time_off(
            organization_id, staff_id, time_off_id, request.model_dump(mode="json")
        )


@router.get(
    "/appointment-services",
    response_model=list[AppointmentService],
    dependencies=[Depends(require_member)],
)
async def list_services(organization_id: UUID, repository: Repository) -> list[AppointmentService]:
    with safe_errors():
        return await repository.list_services(organization_id)


@router.post(
    "/appointment-services",
    response_model=AppointmentService,
    status_code=201,
    dependencies=[Depends(require_manager)],
)
async def create_service(
    organization_id: UUID, request: ServiceRequest, repository: Repository
) -> AppointmentService:
    with safe_errors():
        return await repository.create_service(
            organization_id, request.name, request.duration_minutes, request.buffer_minutes
        )


@router.get(
    "/appointment-resources",
    response_model=list[AppointmentResource],
    dependencies=[Depends(require_member)],
)
async def list_resources(
    organization_id: UUID, repository: Repository
) -> list[AppointmentResource]:
    with safe_errors():
        return await repository.list_resources(organization_id)


@router.post(
    "/appointment-resources",
    response_model=AppointmentResource,
    status_code=201,
    dependencies=[Depends(require_manager)],
)
async def create_resource(
    organization_id: UUID, request: ResourceRequest, repository: Repository
) -> AppointmentResource:
    with safe_errors():
        return await repository.create_resource(
            organization_id, request.name, request.kind, request.operation_id
        )


@router.put(
    "/appointment-resources/{resource_id}",
    response_model=AppointmentResource,
    dependencies=[Depends(require_manager)],
)
async def update_resource(
    organization_id: UUID,
    resource_id: UUID,
    request: ResourceUpdateRequest,
    repository: Repository,
) -> AppointmentResource:
    with safe_errors():
        return await repository.update_resource(
            organization_id, resource_id, request.model_dump(mode="json")
        )


@router.get(
    "/appointment-services/{service_id}/resource-requirements",
    response_model=list[ResourceRequirement],
    dependencies=[Depends(require_member)],
)
async def list_service_resource_requirements(
    organization_id: UUID, service_id: UUID, repository: Repository
) -> list[AppointmentServiceResourceRequirement]:
    with safe_errors():
        return await repository.list_service_resource_requirements(organization_id, service_id)


@router.put(
    "/appointment-services/{service_id}/resource-requirements",
    response_model=ServiceResourceRequirementsResult,
    dependencies=[Depends(require_manager)],
)
async def replace_service_resource_requirements(
    organization_id: UUID,
    service_id: UUID,
    request: ResourceRequirementsRequest,
    repository: Repository,
) -> ServiceResourceRequirementsResult:
    with safe_errors():
        return await repository.replace_service_resource_requirements(
            organization_id, service_id, request.model_dump(mode="json")
        )


@router.get(
    "/appointments", response_model=list[Appointment], dependencies=[Depends(require_member)]
)
async def list_appointments(
    organization_id: UUID,
    repository: Repository,
    customer_id: UUID | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> list[Appointment]:
    if (from_date is None) != (to_date is None):
        raise HTTPException(422, "Both dates are required")
    if (
        from_date is not None
        and to_date is not None
        and (to_date < from_date or (to_date - from_date).days > 366)
    ):
        raise HTTPException(422, "Invalid appointment period")
    with safe_errors():
        return await repository.list_appointments(organization_id, customer_id, from_date, to_date)


@router.post(
    "/appointments",
    response_model=Appointment,
    status_code=201,
    dependencies=[Depends(require_member)],
)
async def create_appointment(
    organization_id: UUID, request: SaveRequest, repository: Repository
) -> Appointment:
    if request.expected_version is not None:
        raise HTTPException(422, "Version is not allowed when creating an appointment")
    with safe_errors():
        return await repository.save(organization_id, None, request.model_dump(mode="json"))


@router.put(
    "/appointments/{appointment_id}",
    response_model=Appointment,
    dependencies=[Depends(require_member)],
)
async def update_appointment(
    organization_id: UUID, appointment_id: UUID, request: SaveRequest, repository: Repository
) -> Appointment:
    if request.expected_version is None:
        raise HTTPException(422, "Expected version is required")
    with safe_errors():
        return await repository.save(
            organization_id, appointment_id, request.model_dump(mode="json")
        )


@router.post(
    "/appointments/{appointment_id}/transitions",
    response_model=Appointment,
    dependencies=[Depends(require_member)],
)
async def transition_appointment(
    organization_id: UUID, appointment_id: UUID, request: TransitionRequest, repository: Repository
) -> Appointment:
    if request.target_status == "canceled" and not request.reason:
        raise HTTPException(422, "Cancellation reason is required")
    with safe_errors():
        return await repository.transition(
            organization_id, appointment_id, request.model_dump(mode="json")
        )
