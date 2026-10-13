from uuid import UUID

from business_assistant_desktop.appointment_resource_dialog import AppointmentResourceDialog
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMessageBox

ORG = UUID("11111111-1111-1111-1111-111111111111")
SERVICE = UUID("22222222-2222-2222-2222-222222222222")
SERVICE_2 = UUID("22222222-2222-2222-2222-222222222223")
RESOURCE = UUID("33333333-3333-3333-3333-333333333333")


class Client:
    def __init__(self):
        self.created = []
        self.updated = []
        self.replaced = []
        self.active = True

    def list_appointment_resources(self, organization_id):
        return [
            {
                "id": str(RESOURCE),
                "name": "관리실 1",
                "kind": "room",
                "is_active": self.active,
                "version": 1 if self.active else 2,
            },
        ]

    def list_appointment_services(self, organization_id):
        return [
            {
                "id": str(SERVICE),
                "name": "피부 관리",
                "duration_minutes": 60,
                "buffer_minutes": 10,
                "is_active": True,
                "resource_version": 1,
            },
            {
                "id": str(SERVICE_2),
                "name": "레이저 관리",
                "duration_minutes": 30,
                "buffer_minutes": 10,
                "is_active": True,
                "resource_version": 1,
            },
        ]

    def list_appointment_service_resource_requirements(self, organization_id, service_id):
        return [{"kind": "room", "quantity": 1}]

    def create_appointment_resource(self, organization_id, name, kind, operation_id):
        self.created.append((name, kind, operation_id))

    def update_appointment_resource(self, organization_id, resource_id, payload):
        self.updated.append((resource_id, payload))
        self.active = payload["is_active"]

    def replace_appointment_service_resource_requirements(
        self, organization_id, service_id, payload
    ):
        self.replaced.append((service_id, payload))


def test_resource_dialog_manages_catalog_and_requirements(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = AppointmentResourceDialog(client, ORG)
    qtbot.addWidget(dialog)
    assert dialog.resource_table.rowCount() == 1
    assert dialog.room_quantity.value() == 1

    dialog.resource_name.setText("레이저 1")
    dialog.resource_kind.setCurrentIndex(1)
    qtbot.mouseClick(dialog.add_button, Qt.MouseButton.LeftButton)
    assert client.created[0][:2] == ("레이저 1", "equipment")
    assert isinstance(client.created[0][2], UUID)

    dialog.resource_table.selectRow(0)
    qtbot.mouseClick(dialog.toggle_button, Qt.MouseButton.LeftButton)
    assert client.updated[-1][0] == RESOURCE
    assert client.updated[-1][1]["is_active"] is False

    dialog.equipment_quantity.setValue(1)
    qtbot.mouseClick(dialog.save_requirements_button, Qt.MouseButton.LeftButton)
    assert client.replaced[-1][0] == SERVICE
    assert client.replaced[-1][1]["requirements"] == [
        {"kind": "room", "quantity": 1},
        {"kind": "equipment", "quantity": 1},
    ]


def test_resource_dialog_preserves_inputs_on_failure(qtbot):  # type: ignore[no-untyped-def]
    class FailingClient(Client):
        def create_appointment_resource(self, organization_id, name, kind, operation_id):
            self.created.append((name, kind, operation_id))
            raise RuntimeError("offline")

    client = FailingClient()
    dialog = AppointmentResourceDialog(client, ORG)
    qtbot.addWidget(dialog)
    dialog.resource_name.setText("새 관리실")
    qtbot.mouseClick(dialog.add_button, Qt.MouseButton.LeftButton)
    qtbot.mouseClick(dialog.add_button, Qt.MouseButton.LeftButton)
    assert dialog.resource_name.text() == "새 관리실"
    assert client.created[0][2] == client.created[1][2]
    assert "실패" in dialog.error.text()


def test_resource_dialog_protects_requirement_on_service_switch_and_close(
    qtbot, monkeypatch
):  # type: ignore[no-untyped-def]
    dialog = AppointmentResourceDialog(Client(), ORG)
    qtbot.addWidget(dialog)
    dialog.room_quantity.setValue(2)
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args, **kwargs: QMessageBox.StandardButton.Cancel,
    )
    dialog.service.setCurrentIndex(1)
    assert dialog.service.currentIndex() == 0
    assert dialog.room_quantity.value() == 2
    dialog.show()
    dialog.reject()
    assert dialog.isVisible()
