from uuid import UUID

import business_assistant_desktop.appointment_page as appointment_module
from business_assistant_desktop.api_client import Customer
from business_assistant_desktop.appointment_page import AppointmentPage
from PySide6.QtCore import Qt

ORG = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER = UUID("22222222-2222-2222-2222-222222222222")
STAFF = UUID("33333333-3333-3333-3333-333333333333")
SERVICE = UUID("44444444-4444-4444-4444-444444444444")
APPOINTMENT = UUID("55555555-5555-5555-5555-555555555555")


class Client:
    def __init__(self):
        self.rows = []
        self.saved = []
        self.transitions = []
        self.fail = False

    def list_customers(self, organization_id):
        assert organization_id == ORG
        return [Customer(id=CUSTOMER, name="고객")]

    def list_appointment_staff(self, organization_id):
        return [{"id": str(STAFF), "name": "담당자", "is_active": True}]

    def list_appointment_services(self, organization_id):
        return [
            {
                "id": str(SERVICE),
                "name": "관리",
                "duration_minutes": 60,
                "buffer_minutes": 10,
                "is_active": True,
            }
        ]

    def list_appointments(self, organization_id):
        return self.rows

    def save_appointment(self, organization_id, appointment_id, payload):
        self.saved.append((appointment_id, payload))
        if self.fail:
            raise RuntimeError("conflict")
        self.rows = [
            {
                "id": str(APPOINTMENT),
                "customer_id": str(CUSTOMER),
                "staff_id": str(STAFF),
                "service_id": str(SERVICE),
                "service_name_snapshot": "관리",
                "start_at": payload["start_at"],
                "status": "reserved",
                "source": "manual",
                "version": 1,
            }
        ]

    def transition_appointment(self, organization_id, appointment_id, payload):
        self.transitions.append(payload)


def test_appointment_create_and_failed_edit_preserves_input(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    page = AppointmentPage(client, ORG, True)
    qtbot.addWidget(page)
    page.start.setText("2026-10-08T14:00:00+09:00")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert client.saved[0][0] is None
    assert client.saved[0][1]["customer_id"] == str(CUSTOMER)
    assert page.table.rowCount() == 1
    page.table.selectRow(0)
    page.start.setText("2026-10-08T15:00:00+09:00")
    client.fail = True
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert client.saved[-1][0] == APPOINTMENT
    assert client.saved[-1][1]["expected_version"] == 1
    assert page.start.text() == "2026-10-08T15:00:00+09:00"


def test_appointment_requires_offset_and_selection_for_transition(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    page = AppointmentPage(client, ORG, False)
    qtbot.addWidget(page)
    page.start.setText("2026-10-08T14:00:00")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert not client.saved
    assert "시간대" in page.error.text()
    page._transition("confirmed")
    assert not client.transitions


def test_treatment_link_only_opens_checked_in_customer(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    client.rows = [
        {
            "id": str(APPOINTMENT),
            "customer_id": str(CUSTOMER),
            "staff_id": str(STAFF),
            "service_id": str(SERVICE),
            "service_name_snapshot": "관리",
            "start_at": "2026-10-08T14:00:00+09:00",
            "status": "reserved",
            "source": "manual",
            "version": 1,
        }
    ]
    page = AppointmentPage(client, ORG, False)
    qtbot.addWidget(page)
    opened = []
    page.treatment_requested.connect(opened.append)
    page.table.selectRow(0)
    assert not page.treatment_button.isEnabled()
    page._open_treatment()
    assert opened == []

    client.rows[0]["status"] = "checked_in"
    page.refresh()
    page.table.selectRow(0)
    assert page.treatment_button.isEnabled()
    qtbot.mouseClick(page.treatment_button, Qt.MouseButton.LeftButton)
    assert opened == [str(CUSTOMER)]

    restricted = AppointmentPage(client, ORG, False, can_open_treatment=False)
    qtbot.addWidget(restricted)
    restricted.table.selectRow(0)
    assert not restricted.treatment_button.isEnabled()


def test_manager_opens_selected_staff_availability(qtbot, monkeypatch):  # type: ignore[no-untyped-def]
    opened = []

    class Dialog:
        def __init__(self, client, organization_id, staff, parent):
            opened.append((client, organization_id, staff, parent))

        def exec(self):
            return 0

    monkeypatch.setattr(appointment_module, "StaffAvailabilityDialog", Dialog)
    client = Client()
    page = AppointmentPage(client, ORG, True)
    qtbot.addWidget(page)
    qtbot.mouseClick(page.availability_button, Qt.MouseButton.LeftButton)
    assert opened[0][0] is client
    assert opened[0][1] == ORG
    assert opened[0][2]["id"] == str(STAFF)

    member_page = AppointmentPage(client, ORG, False)
    qtbot.addWidget(member_page)
    assert not member_page.availability_button.isEnabled()
