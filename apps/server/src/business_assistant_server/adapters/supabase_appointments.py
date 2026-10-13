"""Appointment records through caller-token, organization-scoped PostgREST."""

from datetime import date, datetime, time, timedelta, timezone
from typing import Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from business_assistant_server.adapters.supabase_sale_carts import SupabaseSaleCartRepository
from business_assistant_server.ports.repositories import (
    RepositoryNotFoundError,
    RepositoryUnavailableError,
)


class AppointmentRow(BaseModel):
    id: UUID
    organization_id: UUID


AppointmentModel = TypeVar("AppointmentModel", bound=AppointmentRow)


class AppointmentStaff(AppointmentRow):
    name: str
    is_active: bool
    schedule_version: int = Field(default=1, ge=1)


class AppointmentService(AppointmentRow):
    name: str
    duration_minutes: int = Field(ge=5, le=480)
    buffer_minutes: int = Field(ge=0, le=120)
    is_active: bool
    resource_version: int = Field(default=1, ge=1)


class AppointmentResource(AppointmentRow):
    name: str
    kind: Literal["room", "equipment"]
    is_active: bool
    version: int = Field(ge=1)


class AppointmentServiceResourceRequirement(AppointmentRow):
    service_id: UUID
    kind: Literal["room", "equipment"]
    quantity: int = Field(ge=1, le=10)


class ServiceResourceRequirementsResult(BaseModel):
    service_id: UUID
    resource_version: int = Field(ge=1)
    requirements: list[dict[str, object]]


class Appointment(AppointmentRow):
    customer_id: UUID
    staff_id: UUID
    service_id: UUID
    service_name_snapshot: str
    duration_minutes: int
    buffer_minutes: int
    start_at: str
    end_at: str
    status: Literal["reserved", "confirmed", "checked_in", "completed", "canceled", "no_show"]
    source: Literal["manual", "phone", "walk_in", "online"]
    cancellation_reason: str | None
    version: int = Field(ge=1)
    resource_ids: list[UUID] = Field(default_factory=list, max_length=20)


class AppointmentWorkingHour(AppointmentRow):
    staff_id: UUID
    weekday: int = Field(ge=1, le=7)
    start_time: str
    end_time: str
    timezone_name: str


class AppointmentTimeOff(AppointmentRow):
    staff_id: UUID
    start_at: str
    end_at: str
    reason: str
    status: Literal["active", "canceled"]
    version: int = Field(ge=1)


class WorkingHoursResult(BaseModel):
    staff_id: UUID
    schedule_version: int = Field(ge=1)
    timezone_name: str
    hours: list[AppointmentWorkingHour]


class StaffAvailability(BaseModel):
    staff_id: UUID
    schedule_version: int = Field(ge=1)
    hours: list[AppointmentWorkingHour]
    time_off: list[AppointmentTimeOff]


class SupabaseAppointmentRepository(SupabaseSaleCartRepository):
    async def _list(
        self, table: str, model: type[AppointmentModel], organization_id: UUID, **filters: str
    ) -> list[AppointmentModel]:
        items: list[AppointmentModel] = []
        while True:
            payload = await self._request(
                "GET",
                table,
                params={
                    "organization_id": f"eq.{organization_id}",
                    "order": "id.asc",
                    "limit": "200",
                    "offset": str(len(items)),
                    **filters,
                },
            )
            if not isinstance(payload, list):
                raise RepositoryUnavailableError()
            try:
                page = [model.model_validate(row) for row in payload]
            except ValidationError as error:
                raise RepositoryUnavailableError() from error
            if any(item.organization_id != organization_id for item in page):
                raise RepositoryUnavailableError()
            items.extend(page)
            if len(page) < 200:
                if len({item.id for item in items}) != len(items):
                    raise RepositoryUnavailableError()
                return items

    async def list_staff(self, organization_id: UUID) -> list[AppointmentStaff]:
        return await self._list("appointment_staff", AppointmentStaff, organization_id)

    async def list_services(self, organization_id: UUID) -> list[AppointmentService]:
        return await self._list("appointment_services", AppointmentService, organization_id)

    async def list_resources(self, organization_id: UUID) -> list[AppointmentResource]:
        return await self._list("appointment_resources", AppointmentResource, organization_id)

    async def list_service_resource_requirements(
        self, organization_id: UUID, service_id: UUID
    ) -> list[AppointmentServiceResourceRequirement]:
        return await self._list(
            "appointment_service_resource_requirements",
            AppointmentServiceResourceRequirement,
            organization_id,
            service_id=f"eq.{service_id}",
        )

    async def get_staff_availability(
        self, organization_id: UUID, staff_id: UUID
    ) -> StaffAvailability:
        staff_rows = await self._list(
            "appointment_staff",
            AppointmentStaff,
            organization_id,
            id=f"eq.{staff_id}",
        )
        staff = next((item for item in staff_rows if item.id == staff_id), None)
        if staff is None:
            raise RepositoryNotFoundError()
        hours = await self._list(
            "appointment_staff_working_hours",
            AppointmentWorkingHour,
            organization_id,
            staff_id=f"eq.{staff_id}",
        )
        time_off = await self._list(
            "appointment_staff_time_off",
            AppointmentTimeOff,
            organization_id,
            staff_id=f"eq.{staff_id}",
            status="eq.active",
        )
        return StaffAvailability(
            staff_id=staff.id,
            schedule_version=staff.schedule_version,
            hours=hours,
            time_off=time_off,
        )

    async def list_appointments(
        self,
        organization_id: UUID,
        customer_id: UUID | None = None,
        from_date: date | None = None,
        to_date: date | None = None,
    ) -> list[Appointment]:
        korea = timezone(timedelta(hours=9))
        start_day = from_date or datetime.now(korea).date() - timedelta(days=7)
        end_day = to_date or datetime.now(korea).date() + timedelta(days=60)
        start = datetime.combine(start_day, time.min, korea).isoformat()
        end = datetime.combine(end_day + timedelta(days=1), time.min, korea).isoformat()
        filters = {"customer_id": f"eq.{customer_id}"} if customer_id else {}
        filters["and"] = f"(start_at.gte.{start},start_at.lt.{end})"
        return await self._list("appointments", Appointment, organization_id, **filters)

    async def _single(
        self, name: str, model: type[AppointmentModel], organization_id: UUID, **values: object
    ) -> AppointmentModel:
        payload = await self._request(
            "POST", f"rpc/{name}", json={"p_organization_id": str(organization_id), **values}
        )
        try:
            result = model.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if result.organization_id != organization_id:
            raise RepositoryUnavailableError()
        return result

    async def create_staff(self, organization_id: UUID, name: str) -> AppointmentStaff:
        return await self._single(
            "create_appointment_staff", AppointmentStaff, organization_id, p_name=name
        )

    async def create_service(
        self, organization_id: UUID, name: str, duration_minutes: int, buffer_minutes: int
    ) -> AppointmentService:
        return await self._single(
            "create_appointment_service",
            AppointmentService,
            organization_id,
            p_name=name,
            p_duration_minutes=duration_minutes,
            p_buffer_minutes=buffer_minutes,
        )

    async def create_resource(
        self, organization_id: UUID, name: str, kind: str, operation_id: UUID
    ) -> AppointmentResource:
        return await self._single(
            "create_appointment_resource",
            AppointmentResource,
            organization_id,
            p_name=name,
            p_kind=kind,
            p_operation_id=str(operation_id),
        )

    async def update_resource(
        self, organization_id: UUID, resource_id: UUID, values: dict[str, object]
    ) -> AppointmentResource:
        result = await self._single(
            "update_appointment_resource",
            AppointmentResource,
            organization_id,
            p_resource_id=str(resource_id),
            p_name=values["name"],
            p_is_active=values["is_active"],
            p_expected_version=values["expected_version"],
            p_operation_id=str(values["operation_id"]),
        )
        if result.id != resource_id:
            raise RepositoryUnavailableError()
        return result

    async def replace_service_resource_requirements(
        self, organization_id: UUID, service_id: UUID, values: dict[str, object]
    ) -> ServiceResourceRequirementsResult:
        payload = await self._request(
            "POST",
            "rpc/replace_appointment_service_resource_requirements",
            json={
                "p_organization_id": str(organization_id),
                "p_service_id": str(service_id),
                "p_requirements": values["requirements"],
                "p_expected_version": values["expected_version"],
                "p_operation_id": str(values["operation_id"]),
            },
        )
        try:
            result = ServiceResourceRequirementsResult.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if result.service_id != service_id:
            raise RepositoryUnavailableError()
        return result

    async def save(
        self, organization_id: UUID, appointment_id: UUID | None, values: dict[str, object]
    ) -> Appointment:
        def json_value(value: object) -> object:
            if isinstance(value, UUID):
                return str(value)
            if isinstance(value, list):
                return [str(item) if isinstance(item, UUID) else item for item in value]
            return value

        payload = {f"p_{key}": json_value(value) for key, value in values.items()}
        result = await self._single(
            "save_appointment_with_resources",
            Appointment,
            organization_id,
            p_appointment_id=str(appointment_id) if appointment_id else None,
            **payload,
        )
        if appointment_id is not None and result.id != appointment_id:
            raise RepositoryUnavailableError()
        return result

    async def transition(
        self, organization_id: UUID, appointment_id: UUID, values: dict[str, object]
    ) -> Appointment:
        payload = {
            f"p_{key}": str(value) if isinstance(value, UUID) else value
            for key, value in values.items()
        }
        result = await self._single(
            "transition_appointment",
            Appointment,
            organization_id,
            p_appointment_id=str(appointment_id),
            **payload,
        )
        if result.id != appointment_id:
            raise RepositoryUnavailableError()
        return result

    async def replace_staff_hours(
        self, organization_id: UUID, staff_id: UUID, values: dict[str, object]
    ) -> WorkingHoursResult:
        payload = await self._request(
            "POST",
            "rpc/replace_appointment_staff_hours",
            json={
                "p_organization_id": str(organization_id),
                "p_staff_id": str(staff_id),
                "p_timezone_name": values["timezone_name"],
                "p_hours": values["hours"],
                "p_expected_version": values["expected_version"],
                "p_operation_id": str(values["operation_id"]),
            },
        )
        try:
            result = WorkingHoursResult.model_validate(payload)
        except ValidationError as error:
            raise RepositoryUnavailableError() from error
        if result.staff_id != staff_id or any(
            hour.organization_id != organization_id or hour.staff_id != staff_id
            for hour in result.hours
        ):
            raise RepositoryUnavailableError()
        return result

    async def create_staff_time_off(
        self, organization_id: UUID, staff_id: UUID, values: dict[str, object]
    ) -> AppointmentTimeOff:
        result = await self._single(
            "create_appointment_staff_time_off",
            AppointmentTimeOff,
            organization_id,
            p_staff_id=str(staff_id),
            p_start_at=values["start_at"],
            p_end_at=values["end_at"],
            p_reason=values["reason"],
            p_operation_id=str(values["operation_id"]),
        )
        if result.staff_id != staff_id:
            raise RepositoryUnavailableError()
        return result

    async def cancel_staff_time_off(
        self,
        organization_id: UUID,
        staff_id: UUID,
        time_off_id: UUID,
        values: dict[str, object],
    ) -> AppointmentTimeOff:
        result = await self._single(
            "cancel_appointment_staff_time_off",
            AppointmentTimeOff,
            organization_id,
            p_time_off_id=str(time_off_id),
            p_expected_version=values["expected_version"],
            p_operation_id=str(values["operation_id"]),
        )
        if result.id != time_off_id or result.staff_id != staff_id:
            raise RepositoryUnavailableError()
        return result
