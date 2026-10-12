"""Staff working-hours and time-off management for appointments."""

from datetime import timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from PySide6.QtCore import QDateTime, QTime
from PySide6.QtWidgets import (
    QCheckBox,
    QDateTimeEdit,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGridLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTimeEdit,
    QVBoxLayout,
)

from business_assistant_desktop.ui_components import polish_table, surface_panel

_KST = timezone(timedelta(hours=9))
_DAYS = {1: "월", 2: "화", 3: "수", 4: "목", 5: "금", 6: "토", 7: "일"}


def _kst_iso(value: QDateTime) -> str:
    result = value.toPython()
    if result.tzinfo is None or result.utcoffset() is None:
        result = result.replace(tzinfo=_KST)
    else:
        result = result.astimezone(_KST)
    return result.isoformat(timespec="seconds")


class StaffAvailabilityDialog(QDialog):
    def __init__(
        self, client: Any, organization_id: UUID, staff: dict[str, object], parent: Any = None
    ) -> None:
        super().__init__(parent)
        self._client = client
        self._organization_id = organization_id
        self._staff_id = UUID(str(staff["id"]))
        self.schedule_version = int(staff.get("schedule_version", 1))
        self._time_off_rows: list[dict[str, object]] = []
        self.setWindowTitle(f"{staff.get('name', '담당자')} · 근무시간과 휴무")
        self.resize(760, 680)

        self.day_enabled: dict[int, QCheckBox] = {}
        self.day_start: dict[int, QTimeEdit] = {}
        self.day_end: dict[int, QTimeEdit] = {}
        hours_grid = QGridLayout()
        hours_grid.addWidget(QLabel("근무일"), 0, 0)
        hours_grid.addWidget(QLabel("시작"), 0, 1)
        hours_grid.addWidget(QLabel("종료"), 0, 2)
        for row, weekday in enumerate(_DAYS, start=1):
            enabled = QCheckBox(_DAYS[weekday])
            start = QTimeEdit(QTime(9, 0))
            end = QTimeEdit(QTime(18, 0))
            start.setDisplayFormat("HH:mm")
            end.setDisplayFormat("HH:mm")
            enabled.toggled.connect(start.setEnabled)
            enabled.toggled.connect(end.setEnabled)
            start.setEnabled(False)
            end.setEnabled(False)
            self.day_enabled[weekday] = enabled
            self.day_start[weekday] = start
            self.day_end[weekday] = end
            hours_grid.addWidget(enabled, row, 0)
            hours_grid.addWidget(start, row, 1)
            hours_grid.addWidget(end, row, 2)
        self.save_hours_button = QPushButton("근무시간 저장")
        self.save_hours_button.setProperty("role", "primary")
        self.save_hours_button.clicked.connect(self._save_hours)
        hours_box = QVBoxLayout()
        hours_box.addLayout(hours_grid)
        hours_box.addWidget(self.save_hours_button)

        self.time_off_start = QDateTimeEdit(QDateTime.currentDateTime().addDays(1))
        self.time_off_end = QDateTimeEdit(QDateTime.currentDateTime().addDays(1).addSecs(3600))
        for editor in (self.time_off_start, self.time_off_end):
            editor.setCalendarPopup(True)
            editor.setDisplayFormat("yyyy-MM-dd HH:mm")
        self.time_off_reason = QLineEdit()
        self.time_off_reason.setPlaceholderText("예: 교육, 연차, 개인 일정")
        leave_form = QFormLayout()
        leave_form.addRow("시작", self.time_off_start)
        leave_form.addRow("종료", self.time_off_end)
        leave_form.addRow("사유", self.time_off_reason)
        self.add_time_off_button = QPushButton("휴무 등록")
        self.add_time_off_button.clicked.connect(self._add_time_off)
        leave_form.addRow("", self.add_time_off_button)

        self.time_off_table = QTableWidget(0, 3)
        self.time_off_table.setHorizontalHeaderLabels(["기간", "사유", "상태"])
        self.time_off_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.time_off_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.time_off_table)
        self.cancel_time_off_button = QPushButton("선택 휴무 취소")
        self.cancel_time_off_button.clicked.connect(self._cancel_time_off)
        leave_box = QVBoxLayout()
        leave_box.addLayout(leave_form)
        leave_box.addWidget(self.time_off_table)
        leave_box.addWidget(self.cancel_time_off_button)

        self.error = QLabel()
        self.error.setObjectName("error")
        self.error.setWordWrap(True)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 18)
        layout.addWidget(surface_panel("주간 근무시간 · 한국 시간", hours_box))
        layout.addWidget(surface_panel("휴무", leave_box), 1)
        layout.addWidget(self.error)
        layout.addWidget(buttons)
        self.refresh()

    def refresh(self) -> None:
        try:
            payload = self._client.get_appointment_staff_availability(
                self._organization_id, self._staff_id
            )
        except Exception:
            self.error.setText("근무시간을 불러오지 못했습니다. 037 SQL 적용 상태를 확인하세요.")
            return
        self.schedule_version = int(payload["schedule_version"])
        for weekday in _DAYS:
            self.day_enabled[weekday].setChecked(False)
            self.day_start[weekday].setTime(QTime(9, 0))
            self.day_end[weekday].setTime(QTime(18, 0))
        for item in payload.get("hours", []):
            weekday = int(item["weekday"])
            if weekday not in _DAYS:
                continue
            self.day_enabled[weekday].setChecked(True)
            self.day_start[weekday].setTime(
                QTime.fromString(str(item["start_time"])[:5], "HH:mm")
            )
            self.day_end[weekday].setTime(
                QTime.fromString(str(item["end_time"])[:5], "HH:mm")
            )
        self._time_off_rows = list(payload.get("time_off", []))
        self.time_off_table.setRowCount(0)
        for item in self._time_off_rows:
            row = self.time_off_table.rowCount()
            self.time_off_table.insertRow(row)
            values = [
                f"{item['start_at']} ~ {item['end_at']}",
                str(item["reason"]),
                "사용 중" if item.get("status") == "active" else "취소",
            ]
            for column, value in enumerate(values):
                self.time_off_table.setItem(row, column, QTableWidgetItem(value))
        self.error.clear()

    def _save_hours(self) -> None:
        hours = []
        for weekday in _DAYS:
            if not self.day_enabled[weekday].isChecked():
                continue
            start = self.day_start[weekday].time()
            end = self.day_end[weekday].time()
            if end <= start:
                self.error.setText(f"{_DAYS[weekday]}요일 종료 시간은 시작 시간보다 늦어야 합니다.")
                return
            hours.append(
                {
                    "weekday": weekday,
                    "start": start.toString("HH:mm"),
                    "end": end.toString("HH:mm"),
                }
            )
        try:
            result = self._client.replace_appointment_staff_hours(
                self._organization_id,
                self._staff_id,
                {
                    "timezone_name": "Asia/Seoul",
                    "hours": hours,
                    "expected_version": self.schedule_version,
                    "operation_id": str(uuid4()),
                },
            )
        except Exception:
            self.error.setText(
                "근무시간 저장에 실패했습니다. 기존 예약과 충돌하거나 "
                "다른 사용자가 변경했을 수 있습니다."
            )
            return
        self.schedule_version = int(result["schedule_version"])
        self.error.clear()

    def _add_time_off(self) -> None:
        if self.time_off_end.dateTime() <= self.time_off_start.dateTime():
            self.error.setText("휴무 종료는 시작보다 늦어야 합니다.")
            return
        reason = self.time_off_reason.text().strip()
        if not reason:
            self.error.setText("휴무 사유를 입력하세요.")
            return
        try:
            self._client.create_appointment_staff_time_off(
                self._organization_id,
                self._staff_id,
                {
                    "start_at": _kst_iso(self.time_off_start.dateTime()),
                    "end_at": _kst_iso(self.time_off_end.dateTime()),
                    "reason": reason,
                    "operation_id": str(uuid4()),
                },
            )
        except Exception:
            self.error.setText("휴무 등록에 실패했습니다. 기존 예약과 겹치는지 확인하세요.")
            return
        self.time_off_reason.clear()
        self.refresh()

    def _cancel_time_off(self) -> None:
        row = self.time_off_table.currentRow()
        if row < 0 or row >= len(self._time_off_rows):
            self.error.setText("취소할 휴무를 선택하세요.")
            return
        item = self._time_off_rows[row]
        try:
            self._client.cancel_appointment_staff_time_off(
                self._organization_id,
                self._staff_id,
                UUID(str(item["id"])),
                {"expected_version": int(item["version"]), "operation_id": str(uuid4())},
            )
        except Exception:
            self.error.setText("휴무 취소에 실패했습니다. 최신 상태를 다시 확인하세요.")
            return
        self.refresh()
