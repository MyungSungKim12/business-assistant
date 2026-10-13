import asyncio
import json
from datetime import date
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.adapters.supabase_appointments import SupabaseAppointmentRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError

ORG = uuid4()


def invoke(payload, customer_id=None):
    requests = []

    def serve(request):
        requests.append(request)
        return httpx.Response(200, json=payload)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repository = SupabaseAppointmentRepository(
                "https://example.supabase.co", "public", "user-token", client
            )
            return await repository.list_appointments(
                ORG, customer_id, date(2026, 10, 1), date(2026, 10, 31)
            )

    return asyncio.run(run()), requests


def test_appointment_query_is_scoped_and_bounded():
    result, requests = invoke([])
    assert result == []
    assert len(requests) == 1
    query = requests[0].url.params
    assert query["organization_id"] == f"eq.{ORG}"
    assert query["and"].startswith("(start_at.gte.2026-10-01T00:00:00+09:00,")
    assert "start_at.lt.2026-11-01T00:00:00+09:00" in query["and"]
    assert requests[0].headers["Authorization"] == "Bearer user-token"


def test_wrong_organization_response_fails_closed():
    row = {
        "id": str(uuid4()),
        "organization_id": str(uuid4()),
        "customer_id": str(uuid4()),
        "staff_id": str(uuid4()),
        "service_id": str(uuid4()),
        "service_name_snapshot": "관리",
        "duration_minutes": 60,
        "buffer_minutes": 10,
        "start_at": "2026-10-08T10:00:00+09:00",
        "end_at": "2026-10-08T11:00:00+09:00",
        "status": "reserved",
        "source": "phone",
        "cancellation_reason": None,
        "version": 1,
    }
    with pytest.raises(RepositoryUnavailableError):
        invoke([row])


def test_staff_availability_queries_and_mutations_are_scoped():
    staff_id, hour_id, leave_id, operation_id = uuid4(), uuid4(), uuid4(), uuid4()
    requests = []
    hour = {
        "id": str(hour_id),
        "organization_id": str(ORG),
        "staff_id": str(staff_id),
        "weekday": 4,
        "start_time": "09:00:00",
        "end_time": "18:00:00",
        "timezone_name": "Asia/Seoul",
    }
    leave = {
        "id": str(leave_id),
        "organization_id": str(ORG),
        "staff_id": str(staff_id),
        "start_at": "2026-10-08T15:00:00+09:00",
        "end_at": "2026-10-08T16:00:00+09:00",
        "reason": "교육",
        "status": "active",
        "version": 1,
    }

    def serve(request):
        requests.append(request)
        path = request.url.path
        if path.endswith("/appointment_staff"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(staff_id),
                        "organization_id": str(ORG),
                        "name": "담당자",
                        "is_active": True,
                        "schedule_version": 1,
                    }
                ],
            )
        if path.endswith("/appointment_staff_working_hours"):
            return httpx.Response(200, json=[hour])
        if path.endswith("/appointment_staff_time_off"):
            return httpx.Response(200, json=[leave])
        if path.endswith("/rpc/replace_appointment_staff_hours"):
            return httpx.Response(
                200,
                json={
                    "staff_id": str(staff_id),
                    "schedule_version": 2,
                    "timezone_name": "Asia/Seoul",
                    "hours": [hour],
                },
            )
        if path.endswith("/rpc/create_appointment_staff_time_off"):
            return httpx.Response(200, json=leave)
        return httpx.Response(200, json={**leave, "status": "canceled", "version": 2})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repository = SupabaseAppointmentRepository(
                "https://example.supabase.co", "public", "user-token", client
            )
            availability = await repository.get_staff_availability(ORG, staff_id)
            hours = await repository.replace_staff_hours(
                ORG,
                staff_id,
                {
                    "timezone_name": "Asia/Seoul",
                    "hours": [{"weekday": 4, "start": "09:00", "end": "18:00"}],
                    "expected_version": 1,
                    "operation_id": operation_id,
                },
            )
            created = await repository.create_staff_time_off(
                ORG,
                staff_id,
                {
                    "start_at": "2026-10-08T15:00:00+09:00",
                    "end_at": "2026-10-08T16:00:00+09:00",
                    "reason": "교육",
                    "operation_id": operation_id,
                },
            )
            canceled = await repository.cancel_staff_time_off(
                ORG,
                staff_id,
                leave_id,
                {"expected_version": 1, "operation_id": operation_id},
            )
            return availability, hours, created, canceled

    availability, hours, created, canceled = asyncio.run(run())
    assert availability.schedule_version == 1
    assert hours.schedule_version == 2
    assert created.id == leave_id
    assert canceled.status == "canceled"
    assert requests[1].url.params["staff_id"] == f"eq.{staff_id}"
    assert requests[2].url.params["status"] == "eq.active"
    assert json.loads(requests[3].content)["p_organization_id"] == str(ORG)


def test_resource_catalog_requirements_and_save_payload_are_scoped():
    resource_id, service_id, customer_id, staff_id, appointment_id = (
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
    )
    requests = []
    resource = {
        "id": str(resource_id),
        "organization_id": str(ORG),
        "name": "관리실 1",
        "kind": "room",
        "is_active": True,
        "version": 1,
    }
    appointment = {
        "id": str(appointment_id),
        "organization_id": str(ORG),
        "customer_id": str(customer_id),
        "staff_id": str(staff_id),
        "service_id": str(service_id),
        "service_name_snapshot": "관리",
        "duration_minutes": 60,
        "buffer_minutes": 10,
        "start_at": "2026-10-08T10:00:00+09:00",
        "end_at": "2026-10-08T11:00:00+09:00",
        "status": "reserved",
        "source": "phone",
        "cancellation_reason": None,
        "version": 1,
        "resource_ids": [str(resource_id)],
    }

    def serve(request):
        requests.append(request)
        path = request.url.path
        if path.endswith("/appointment_resources"):
            return httpx.Response(200, json=[resource])
        if path.endswith("/appointment_service_resource_requirements"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(uuid4()),
                        "organization_id": str(ORG),
                        "service_id": str(service_id),
                        "kind": "room",
                        "quantity": 1,
                    }
                ],
            )
        if path.endswith("/rpc/create_appointment_resource"):
            return httpx.Response(200, json=resource)
        if path.endswith("/rpc/replace_appointment_service_resource_requirements"):
            return httpx.Response(
                200,
                json={
                    "service_id": str(service_id),
                    "resource_version": 2,
                    "requirements": [{"kind": "room", "quantity": 1}],
                },
            )
        return httpx.Response(200, json=appointment)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            repository = SupabaseAppointmentRepository(
                "https://example.supabase.co", "public", "user-token", client
            )
            resources = await repository.list_resources(ORG)
            requirements = await repository.list_service_resource_requirements(ORG, service_id)
            created = await repository.create_resource(
                ORG, "관리실 1", "room", uuid4()
            )
            replaced = await repository.replace_service_resource_requirements(
                ORG,
                service_id,
                {
                    "requirements": [{"kind": "room", "quantity": 1}],
                    "expected_version": 1,
                    "operation_id": uuid4(),
                },
            )
            saved = await repository.save(
                ORG,
                None,
                {
                    "customer_id": customer_id,
                    "staff_id": staff_id,
                    "service_id": service_id,
                    "start_at": "2026-10-08T10:00:00+09:00",
                    "source": "phone",
                    "expected_version": None,
                    "operation_id": uuid4(),
                    "resource_ids": [resource_id],
                },
            )
            return resources, requirements, created, replaced, saved

    resources, requirements, created, replaced, saved = asyncio.run(run())
    assert resources[0].id == resource_id
    assert requirements[0].kind == "room"
    assert created.organization_id == ORG
    assert replaced.resource_version == 2
    assert saved.resource_ids == [resource_id]
    save_body = json.loads(requests[-1].content)
    assert save_body["p_resource_ids"] == [str(resource_id)]
