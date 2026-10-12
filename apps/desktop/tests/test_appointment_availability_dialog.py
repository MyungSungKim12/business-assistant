from uuid import UUID, uuid4

from business_assistant_desktop.appointment_availability_dialog import StaffAvailabilityDialog
from PySide6.QtCore import QDateTime, Qt

ORG = uuid4()
STAFF = uuid4()
TIME_OFF = uuid4()


class Client:
    def __init__(self):
        self.hours = [{"weekday": 1, "start_time": "09:00:00", "end_time": "18:00:00"}]
        self.time_off = [
            {
                "id": str(TIME_OFF),
                "start_at": "2026-10-13T13:00:00+09:00",
                "end_at": "2026-10-13T14:00:00+09:00",
                "reason": "교육",
                "status": "active",
                "version": 1,
            }
        ]
        self.replaced = []
        self.created = []
        self.canceled = []

    def get_appointment_staff_availability(self, organization_id, staff_id):
        assert organization_id == ORG and staff_id == STAFF
        return {
            "staff_id": str(STAFF),
            "schedule_version": 2,
            "hours": self.hours,
            "time_off": self.time_off,
        }

    def replace_appointment_staff_hours(self, organization_id, staff_id, payload):
        self.replaced.append(payload)
        return {"schedule_version": 3, "hours": payload["hours"]}

    def create_appointment_staff_time_off(self, organization_id, staff_id, payload):
        self.created.append(payload)
        return self.time_off[0]

    def cancel_appointment_staff_time_off(
        self, organization_id, staff_id, time_off_id, payload
    ):
        self.canceled.append((time_off_id, payload))
        self.time_off = []
        return {"status": "canceled"}


def test_staff_availability_saves_weekly_hours(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = StaffAvailabilityDialog(client, ORG, {"id": str(STAFF), "name": "김담당"})
    qtbot.addWidget(dialog)
    assert dialog.day_enabled[1].isChecked()
    dialog.day_enabled[2].setChecked(True)
    qtbot.mouseClick(dialog.save_hours_button, Qt.MouseButton.LeftButton)
    assert client.replaced[0]["expected_version"] == 2
    assert [item["weekday"] for item in client.replaced[0]["hours"]] == [1, 2]
    assert dialog.schedule_version == 3


def test_staff_availability_adds_and_cancels_time_off(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = StaffAvailabilityDialog(client, ORG, {"id": str(STAFF), "name": "김담당"})
    qtbot.addWidget(dialog)
    dialog.time_off_start.setDateTime(QDateTime(2026, 10, 14, 10, 0, 0))
    dialog.time_off_end.setDateTime(QDateTime(2026, 10, 14, 11, 0, 0))
    dialog.time_off_reason.setText("개인 일정")
    qtbot.mouseClick(dialog.add_time_off_button, Qt.MouseButton.LeftButton)
    assert client.created[0]["reason"] == "개인 일정"
    assert str(client.created[0]["start_at"]).endswith("+09:00")
    dialog.time_off_table.selectRow(0)
    qtbot.mouseClick(dialog.cancel_time_off_button, Qt.MouseButton.LeftButton)
    assert client.canceled[0][0] == UUID(str(TIME_OFF))
    assert client.canceled[0][1]["expected_version"] == 1
    assert dialog.time_off_table.rowCount() == 0


def test_staff_availability_preserves_invalid_time_off_input(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = StaffAvailabilityDialog(client, ORG, {"id": str(STAFF), "name": "김담당"})
    qtbot.addWidget(dialog)
    moment = QDateTime(2026, 10, 14, 10, 0, 0)
    dialog.time_off_start.setDateTime(moment)
    dialog.time_off_end.setDateTime(moment)
    dialog.time_off_reason.setText("개인 일정")
    qtbot.mouseClick(dialog.add_time_off_button, Qt.MouseButton.LeftButton)
    assert client.created == []
    assert dialog.time_off_reason.text() == "개인 일정"
    assert "종료" in dialog.error.text()
