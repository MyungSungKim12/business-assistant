import json
from uuid import uuid4

import httpx
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_appointment_client_routes_and_scopes_requests():
    organization, appointment, customer, resource = uuid4(), uuid4(), uuid4(), uuid4()
    calls = []

    def serve(request):
        calls.append(request)
        if request.method == "GET" and request.url.path.endswith("/availability"):
            return httpx.Response(
                200,
                json={
                    "staff_id": str(appointment),
                    "schedule_version": 1,
                    "hours": [],
                    "time_off": [],
                },
            )
        return httpx.Response(200, json=[] if request.method == "GET" else {"id": str(appointment)})

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(serve)))
    session = Session("token", None, uuid4())
    assert api.list_appointments(organization, session, customer) == []
    assert api.list_appointment_staff(organization, session) == []
    assert api.list_appointment_services(organization, session) == []
    assert api.list_appointment_resources(organization, session) == []
    assert (
        api.list_appointment_service_resource_requirements(
            organization, session, appointment
        )
        == []
    )
    create_operation = uuid4()
    api.create_appointment_resource(
        organization, session, "관리실 1", "room", create_operation
    )
    api.update_appointment_resource(
        organization, session, resource, {"is_active": False, "expected_version": 1}
    )
    api.replace_appointment_service_resource_requirements(
        organization, session, appointment, {"requirements": []}
    )
    api.save_appointment(organization, session, None, {"operation_id": str(uuid4())})
    api.save_appointment(organization, session, appointment, {"expected_version": 1})
    api.transition_appointment(organization, session, appointment, {"target_status": "confirmed"})
    availability = api.get_appointment_staff_availability(organization, session, appointment)
    assert availability["schedule_version"] == 1
    api.replace_appointment_staff_hours(
        organization, session, appointment, {"expected_version": 1, "hours": []}
    )
    api.create_appointment_staff_time_off(
        organization, session, appointment, {"reason": "교육"}
    )
    api.cancel_appointment_staff_time_off(
        organization, session, appointment, customer, {"expected_version": 1}
    )
    base = f"/api/v1/organizations/{organization}"
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", f"{base}/appointments"),
        ("GET", f"{base}/appointment-staff"),
        ("GET", f"{base}/appointment-services"),
        ("GET", f"{base}/appointment-resources"),
        ("GET", f"{base}/appointment-services/{appointment}/resource-requirements"),
        ("POST", f"{base}/appointment-resources"),
        ("PUT", f"{base}/appointment-resources/{resource}"),
        ("PUT", f"{base}/appointment-services/{appointment}/resource-requirements"),
        ("POST", f"{base}/appointments"),
        ("PUT", f"{base}/appointments/{appointment}"),
        ("POST", f"{base}/appointments/{appointment}/transitions"),
        ("GET", f"{base}/appointment-staff/{appointment}/availability"),
        ("PUT", f"{base}/appointment-staff/{appointment}/working-hours"),
        ("POST", f"{base}/appointment-staff/{appointment}/time-off"),
        ("POST", f"{base}/appointment-staff/{appointment}/time-off/{customer}/cancel"),
    ]
    assert calls[0].url.params["customer_id"] == str(customer)
    assert json.loads(calls[9].content) == {"expected_version": 1}
    assert all(call.headers["Authorization"] == "Bearer token" for call in calls)
