import asyncio
from uuid import UUID, uuid4

import httpx
from business_assistant_server.api.appointments import get_repository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import RepositoryConflictError
from test_document_api import ORGANIZATION_ID, FakeAuthAdapter, FakeOrganizationRepository

APPOINTMENT = uuid4()
CUSTOMER = uuid4()
STAFF = uuid4()
SERVICE = uuid4()
RESOURCE = uuid4()
ROW = {
    "id": str(APPOINTMENT),
    "organization_id": str(ORGANIZATION_ID),
    "customer_id": str(CUSTOMER),
    "staff_id": str(STAFF),
    "service_id": str(SERVICE),
    "service_name_snapshot": "관리",
    "duration_minutes": 60,
    "buffer_minutes": 10,
    "start_at": "2026-10-08T10:00:00+09:00",
    "end_at": "2026-10-08T11:00:00+09:00",
    "status": "reserved",
    "source": "phone",
    "cancellation_reason": None,
    "version": 1,
    "resource_ids": [str(RESOURCE)],
}
RESOURCE_ROW = {
    "id": str(RESOURCE),
    "organization_id": str(ORGANIZATION_ID),
    "name": "관리실 1",
    "kind": "room",
    "is_active": True,
    "version": 1,
}
HOUR = {
    "id": str(uuid4()),
    "organization_id": str(ORGANIZATION_ID),
    "staff_id": str(STAFF),
    "weekday": 4,
    "start_time": "09:00:00",
    "end_time": "18:00:00",
    "timezone_name": "Asia/Seoul",
}
TIME_OFF = {
    "id": str(uuid4()),
    "organization_id": str(ORGANIZATION_ID),
    "staff_id": str(STAFF),
    "start_at": "2026-10-08T15:00:00+09:00",
    "end_at": "2026-10-08T16:00:00+09:00",
    "reason": "교육",
    "status": "active",
    "version": 1,
}


class Repo:
    def __init__(self):
        self.calls = []
        self.error = None

    async def list_appointments(self, *args):
        self.calls.append(args)
        return [ROW]

    async def save(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return ROW

    async def transition(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return ROW

    async def get_staff_availability(self, *args):
        self.calls.append(args)
        return {
            "staff_id": STAFF,
            "schedule_version": 1,
            "hours": [HOUR],
            "time_off": [TIME_OFF],
        }

    async def replace_staff_hours(self, *args):
        self.calls.append(args)
        return {
            "staff_id": str(STAFF),
            "schedule_version": 2,
            "timezone_name": "Asia/Seoul",
            "hours": [HOUR],
        }

    async def create_staff_time_off(self, *args):
        self.calls.append(args)
        return TIME_OFF

    async def cancel_staff_time_off(self, *args):
        self.calls.append(args)
        return {**TIME_OFF, "status": "canceled", "version": 2}

    async def list_resources(self, *args):
        self.calls.append(args)
        return [RESOURCE_ROW]

    async def create_resource(self, *args):
        self.calls.append(args)
        return RESOURCE_ROW

    async def update_resource(self, *args):
        self.calls.append(args)
        return {**RESOURCE_ROW, "is_active": False, "version": 2}

    async def list_service_resource_requirements(self, *args):
        self.calls.append(args)
        return [{"kind": "room", "quantity": 1}]

    async def replace_service_resource_requirements(self, *args):
        self.calls.append(args)
        return {
            "service_id": str(SERVICE),
            "resource_version": 2,
            "requirements": [{"kind": "room", "quantity": 1}],
        }


def send(method="GET", path="appointments", body=None, role="owner", features=None, repo=None):
    repo = repo or Repo()

    async def run():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["task.basic"] if features is None else features, role
        )
        app.dependency_overrides[get_repository] = lambda: repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}/{path}",
                headers={"Authorization": "Bearer owner-token"},
                json=body,
            )

    return asyncio.run(run()), repo


def payload(**changes):
    return {
        "customer_id": str(CUSTOMER),
        "staff_id": str(STAFF),
        "service_id": str(SERVICE),
        "start_at": "2026-10-08T10:00:00+09:00",
        "source": "phone",
        "operation_id": str(uuid4()),
        "resource_ids": [str(RESOURCE)],
        **changes,
    }


def test_create_list_and_update_require_versions():
    result, repo = send("POST", body=payload())
    assert result.status_code == 201
    assert repo.calls[0][0] == ORGANIZATION_ID
    assert repo.calls[0][1] is None
    assert send("GET")[0].status_code == 200
    assert send("PUT", f"appointments/{APPOINTMENT}", payload())[0].status_code == 422
    assert (
        send("PUT", f"appointments/{APPOINTMENT}", payload(expected_version=1))[0].status_code
        == 200
    )
    assert send("POST", body=payload(expected_version=1))[0].status_code == 422


def test_bad_time_state_permissions_and_conflict():
    assert send("POST", body=payload(start_at="2026-10-08T10:00:00"))[0].status_code == 422
    assert send("POST", body=payload(), role="outsider")[0].status_code == 403
    assert send("GET", features=[])[0].status_code == 403
    assert send("GET", path="appointments?from_date=2026-10-01")[0].status_code == 422
    assert (
        send("GET", path="appointments?from_date=2026-11-01&to_date=2026-10-01")[0].status_code
        == 422
    )
    assert (
        send(
            "POST",
            f"appointments/{APPOINTMENT}/transitions",
            {"target_status": "canceled", "expected_version": 1, "operation_id": str(uuid4())},
        )[0].status_code
        == 422
    )
    repo = Repo()
    repo.error = RepositoryConflictError()
    assert send("POST", body=payload(), repo=repo)[0].status_code == 409


def test_member_can_book_but_cannot_manage_staff():
    assert send("POST", body=payload(), role="member")[0].status_code == 201
    assert (
        send("POST", "appointment-staff", {"name": "담당자"}, role="member")[0].status_code == 403
    )


def test_staff_availability_can_be_read_and_managed_by_role():
    response, repo = send("GET", f"appointment-staff/{STAFF}/availability", role="member")
    assert response.status_code == 200
    assert response.json()["hours"][0]["weekday"] == 4
    assert repo.calls[-1] == (ORGANIZATION_ID, STAFF)

    hours_body = {
        "timezone_name": "Asia/Seoul",
        "hours": [{"weekday": 4, "start": "09:00", "end": "18:00"}],
        "expected_version": 1,
        "operation_id": str(uuid4()),
    }
    response, repo = send("PUT", f"appointment-staff/{STAFF}/working-hours", hours_body)
    assert response.status_code == 200
    assert repo.calls[-1][2]["expected_version"] == 1
    assert send(
        "PUT", f"appointment-staff/{STAFF}/working-hours", hours_body, role="member"
    )[0].status_code == 403

    leave_body = {
        "start_at": "2026-10-08T15:00:00+09:00",
        "end_at": "2026-10-08T16:00:00+09:00",
        "reason": "교육",
        "operation_id": str(uuid4()),
    }
    response, repo = send("POST", f"appointment-staff/{STAFF}/time-off", leave_body)
    assert response.status_code == 201
    time_off_id = response.json()["id"]
    cancel_body = {"expected_version": 1, "operation_id": str(uuid4())}
    response, repo = send(
        "POST", f"appointment-staff/{STAFF}/time-off/{time_off_id}/cancel", cancel_body
    )
    assert response.status_code == 200
    assert repo.calls[-1][2] == UUID(TIME_OFF["id"])


def test_staff_availability_rejects_naive_time_and_invalid_ranges():
    invalid = {
        "start_at": "2026-10-08T15:00:00",
        "end_at": "2026-10-08T14:00:00+09:00",
        "reason": "교육",
        "operation_id": str(uuid4()),
    }
    assert send("POST", f"appointment-staff/{STAFF}/time-off", invalid)[0].status_code == 422
    bad_hours = {
        "timezone_name": "Asia/Seoul",
        "hours": [{"weekday": 4, "start": "18:00", "end": "09:00"}],
        "expected_version": 1,
        "operation_id": str(uuid4()),
    }
    assert (
        send("PUT", f"appointment-staff/{STAFF}/working-hours", bad_hours)[0].status_code
        == 422
    )


def test_resource_catalog_and_service_requirements_require_manager():
    response, repo = send("GET", "appointment-resources", role="member")
    assert response.status_code == 200
    assert response.json()[0]["kind"] == "room"

    response, repo = send(
        "POST", "appointment-resources", {
            "name": "관리실 1", "kind": "room", "operation_id": str(uuid4())
        }
    )
    assert response.status_code == 201
    assert repo.calls[-1][:3] == (ORGANIZATION_ID, "관리실 1", "room")
    assert send(
        "POST", "appointment-resources", {
            "name": "장비", "kind": "equipment", "operation_id": str(uuid4())
        }, role="member"
    )[0].status_code == 403

    update = {
        "name": "관리실 1",
        "is_active": False,
        "expected_version": 1,
        "operation_id": str(uuid4()),
    }
    response, repo = send("PUT", f"appointment-resources/{RESOURCE}", update)
    assert response.status_code == 200
    assert repo.calls[-1][1] == RESOURCE
    assert send(
        "PUT", f"appointment-resources/{RESOURCE}", update, role="member"
    )[0].status_code == 403

    response, repo = send("GET", f"appointment-services/{SERVICE}/resource-requirements")
    assert response.status_code == 200
    assert response.json() == [{"kind": "room", "quantity": 1}]
    requirement = {
        "requirements": [{"kind": "room", "quantity": 1}],
        "expected_version": 1,
        "operation_id": str(uuid4()),
    }
    response, repo = send(
        "PUT", f"appointment-services/{SERVICE}/resource-requirements", requirement
    )
    assert response.status_code == 200
    assert repo.calls[-1][2]["requirements"][0]["quantity"] == 1
    assert send(
        "PUT",
        f"appointment-services/{SERVICE}/resource-requirements",
        requirement,
        role="member",
    )[0].status_code == 403


def test_resource_requests_reject_duplicates_and_invalid_values():
    duplicate = payload(resource_ids=[str(RESOURCE), str(RESOURCE)])
    assert send("POST", body=duplicate)[0].status_code == 422
    assert send(
        "POST", "appointment-resources", {
            "name": " ", "kind": "room", "operation_id": str(uuid4())
        }
    )[0].status_code == 422
    assert send(
        "PUT",
        f"appointment-services/{SERVICE}/resource-requirements",
        {
            "requirements": [{"kind": "room", "quantity": 0}],
            "expected_version": 1,
            "operation_id": str(uuid4()),
        },
    )[0].status_code == 422
