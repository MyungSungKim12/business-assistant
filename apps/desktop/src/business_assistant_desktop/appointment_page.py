"""Usable single-branch appointment workflow beside the existing task list."""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.appointment_availability_dialog import StaffAvailabilityDialog
from business_assistant_desktop.task_page import TaskPage
from business_assistant_desktop.ui_components import polish_table, surface_panel

_STATUS = {
    "reserved": "예약",
    "confirmed": "확정",
    "checked_in": "방문",
    "completed": "완료",
    "canceled": "취소",
    "no_show": "노쇼",
}


class AppointmentPage(QWidget):
    treatment_requested = Signal(object)

    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        can_manage: bool,
        can_open_treatment: bool = True,
    ) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id
        self._can_manage = can_manage
        self._can_open_treatment = can_open_treatment
        self._rows: list[dict[str, object]] = []
        self._staff_rows: list[dict[str, object]] = []
        self._selected: dict[str, object] | None = None
        self._baseline: tuple = ()

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["시작", "고객", "서비스", "담당자", "상태"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.itemSelectionChanged.connect(self._load_selected)
        polish_table(self.table)

        self.customer = QComboBox()
        self.staff = QComboBox()
        self.service = QComboBox()
        self.start = QLineEdit()
        self.start.setPlaceholderText("예: 2026-10-08T14:00:00+09:00")
        self.source = QComboBox()
        for label, value in [
            ("직접", "manual"),
            ("전화", "phone"),
            ("무예약 방문", "walk_in"),
            ("온라인", "online"),
        ]:
            self.source.addItem(label, value)

        form = QFormLayout()
        form.addRow("고객", self.customer)
        form.addRow("서비스", self.service)
        form.addRow("담당자", self.staff)
        form.addRow("시작 시각", self.start)
        form.addRow("접수 경로", self.source)
        self.new_button = QPushButton("새 예약")
        self.save_button = QPushButton("예약 저장")
        self.save_button.setProperty("role", "primary")
        self.refresh_button = QPushButton("새로고침")
        self.treatment_button = QPushButton("시술관리 열기")
        self.treatment_button.setEnabled(False)
        self.new_button.clicked.connect(self._new)
        self.save_button.clicked.connect(self._save)
        self.refresh_button.clicked.connect(self.refresh)
        self.treatment_button.clicked.connect(self._open_treatment)
        self.staff_button = QPushButton("담당자 추가")
        self.availability_button = QPushButton("근무시간·휴무")
        self.service_button = QPushButton("서비스 추가")
        self.staff_button.setEnabled(can_manage)
        self.availability_button.setEnabled(False)
        self.service_button.setEnabled(can_manage)
        self.staff_button.clicked.connect(self._add_staff)
        self.availability_button.clicked.connect(self._open_availability)
        self.service_button.clicked.connect(self._add_service)
        toolbar = QHBoxLayout()
        for button in (
            self.new_button,
            self.refresh_button,
            self.treatment_button,
            self.staff_button,
            self.availability_button,
            self.service_button,
        ):
            toolbar.addWidget(button)
        toolbar.addStretch()
        editor = QVBoxLayout()
        editor.addLayout(form)
        editor.addWidget(self.save_button)

        transition_row = QHBoxLayout()
        for label, status in [
            ("확정", "confirmed"),
            ("방문 처리", "checked_in"),
            ("완료", "completed"),
            ("노쇼", "no_show"),
            ("취소", "canceled"),
        ]:
            button = QPushButton(label)
            button.clicked.connect(lambda _checked=False, target=status: self._transition(target))
            transition_row.addWidget(button)
        self.error = QLabel()
        self.error.setObjectName("error")
        self.error.setWordWrap(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        title = QLabel("예약")
        title.setObjectName("page-title")
        layout.addWidget(title)
        layout.addLayout(toolbar)
        layout.addWidget(self.table, 1)
        layout.addWidget(surface_panel("예약 작성 · 변경", editor))
        layout.addLayout(transition_row)
        layout.addWidget(self.error)
        self._baseline = self._draft()
        self.refresh()

    def _draft(self) -> tuple:
        return (
            self.customer.currentData(),
            self.staff.currentData(),
            self.service.currentData(),
            self.start.text(),
            self.source.currentData(),
        )

    def confirm_leave(self) -> bool:
        if self._draft() == self._baseline:
            return True
        answer = QMessageBox.question(
            self,
            "작성 중인 예약",
            "저장하지 않은 예약 변경을 버릴까요?",
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if answer != QMessageBox.StandardButton.Discard:
            return False
        self._baseline = self._draft()
        return True

    @staticmethod
    def _choose(box: QComboBox, value: object) -> None:
        index = box.findData(str(value))
        if index >= 0:
            box.setCurrentIndex(index)

    def refresh(self) -> None:
        if not self.confirm_leave():
            return
        try:
            customers = self._client.list_customers(self._organization_id)
            staff = self._client.list_appointment_staff(self._organization_id)
            services = self._client.list_appointment_services(self._organization_id)
            rows = self._client.list_appointments(self._organization_id)
        except Exception:
            self.error.setText("예약을 불러오지 못했습니다. 서버와 034 SQL 적용 상태를 확인하세요.")
            return
        self.customer.clear()
        for item in customers:
            if getattr(item, "status", "active") not in {"blocked", "inactive"}:
                self.customer.addItem(item.name, str(item.id))
        self.staff.clear()
        self._staff_rows = list(staff)
        for item in staff:
            if item.get("is_active"):
                self.staff.addItem(str(item["name"]), str(item["id"]))
        self.availability_button.setEnabled(self._can_manage and self.staff.count() > 0)
        self.service.clear()
        for item in services:
            if item.get("is_active"):
                self.service.addItem(
                    f"{item['name']} · {item['duration_minutes']}분"
                    f" + 여유 {item['buffer_minutes']}분",
                    str(item["id"]),
                )
        self._rows = sorted(rows, key=lambda item: str(item.get("start_at", "")))
        customer_names = {str(item.id): item.name for item in customers}
        staff_names = {str(item["id"]): str(item["name"]) for item in staff}
        self.table.blockSignals(True)
        self.table.setRowCount(0)
        for appointment in self._rows:
            row = self.table.rowCount()
            self.table.insertRow(row)
            cells = [
                str(appointment["start_at"]),
                customer_names.get(str(appointment["customer_id"]), "고객"),
                str(appointment["service_name_snapshot"]),
                staff_names.get(str(appointment["staff_id"]), "담당자"),
                _STATUS.get(str(appointment["status"]), str(appointment["status"])),
            ]
            for column, value in enumerate(cells):
                self.table.setItem(row, column, QTableWidgetItem(value))
        self.table.clearSelection()
        self.table.blockSignals(False)
        self._selected = None
        self.treatment_button.setEnabled(False)
        self.start.clear()
        self.source.setCurrentIndex(0)
        self._baseline = self._draft()
        self.error.clear()

    def _load_selected(self) -> None:
        index = self.table.currentRow()
        if index < 0 or index >= len(self._rows):
            return
        if not self.confirm_leave():
            self.table.blockSignals(True)
            self.table.clearSelection()
            self.table.blockSignals(False)
            return
        appointment = self._rows[index]
        self._selected = appointment
        self.treatment_button.setEnabled(
            self._can_open_treatment
            and str(appointment["status"]) in {"checked_in", "completed"}
        )
        self._choose(self.customer, appointment["customer_id"])
        self._choose(self.staff, appointment["staff_id"])
        self._choose(self.service, appointment["service_id"])
        self.start.setText(str(appointment["start_at"]))
        self._choose(self.source, appointment["source"])
        self._baseline = self._draft()

    def _new(self) -> None:
        if not self.confirm_leave():
            return
        self.table.clearSelection()
        self._selected = None
        self.treatment_button.setEnabled(False)
        self.start.clear()
        self._baseline = self._draft()
        self.error.clear()

    def _open_treatment(self) -> None:
        selected = self._selected
        if (
            not self._can_open_treatment
            or selected is None
            or selected.get("status") not in {"checked_in", "completed"}
        ):
            return
        if not self.confirm_leave():
            return
        self.treatment_requested.emit(selected["customer_id"])

    def _save(self) -> None:
        try:
            time = datetime.fromisoformat(self.start.text().strip())
            if time.utcoffset() is None:
                raise ValueError("Offset required")
            if not all(
                (self.customer.currentData(), self.staff.currentData(), self.service.currentData())
            ):
                raise ValueError("Catalog required")
        except ValueError:
            self.error.setText("고객·서비스·담당자와 시간대가 포함된 시작 시각을 입력하세요.")
            return
        selected = self._selected
        payload = {
            "customer_id": self.customer.currentData(),
            "staff_id": self.staff.currentData(),
            "service_id": self.service.currentData(),
            "start_at": time.isoformat(),
            "source": self.source.currentData(),
            "operation_id": str(uuid4()),
        }
        if selected is not None:
            payload["expected_version"] = selected["version"]
        try:
            self._client.save_appointment(
                self._organization_id, UUID(str(selected["id"])) if selected else None, payload
            )
        except Exception:
            self.error.setText(
                "예약 저장에 실패했습니다. 충돌 또는 오래된 예약일 수 있습니다. 입력은 유지됩니다."
            )
            return
        self._baseline = self._draft()
        self.refresh()

    def _transition(self, status: str) -> None:
        if self._selected is None:
            self.error.setText("예약을 먼저 선택하세요.")
            return
        if self._draft() != self._baseline:
            self.error.setText("작성 중인 변경을 저장하거나 새로고침한 뒤 상태를 변경하세요.")
            return
        reason = None
        if status == "canceled":
            reason, ok = QInputDialog.getText(self, "예약 취소", "취소 사유")
            if not ok or not reason.strip():
                return
        try:
            self._client.transition_appointment(
                self._organization_id,
                UUID(str(self._selected["id"])),
                {
                    "target_status": status,
                    "reason": reason,
                    "expected_version": self._selected["version"],
                    "operation_id": str(uuid4()),
                },
            )
        except Exception:
            self.error.setText("상태 변경에 실패했습니다. 최신 예약 상태를 확인하세요.")
            return
        self.refresh()

    def _add_staff(self) -> None:
        if not self.confirm_leave():
            return
        name, ok = QInputDialog.getText(self, "담당자 추가", "이름")
        if ok and name.strip():
            try:
                self._client.create_appointment_staff(self._organization_id, name.strip())
                self.refresh()
            except Exception:
                self.error.setText("담당자 추가에 실패했습니다.")

    def _open_availability(self) -> None:
        if not self._can_manage or not self.staff.currentData():
            return
        staff_id = str(self.staff.currentData())
        selected = next(
            (item for item in self._staff_rows if str(item.get("id")) == staff_id), None
        )
        if selected is None:
            self.error.setText("담당자를 다시 선택하세요.")
            return
        StaffAvailabilityDialog(
            self._client, self._organization_id, selected, self
        ).exec()

    def _add_service(self) -> None:
        if not self.confirm_leave():
            return
        name, ok = QInputDialog.getText(self, "서비스 추가", "서비스명")
        if not ok or not name.strip():
            return
        duration, ok = QInputDialog.getInt(self, "서비스 추가", "소요 시간(분)", 60, 5, 480, 5)
        if not ok:
            return
        buffer, ok = QInputDialog.getInt(self, "서비스 추가", "여유 시간(분)", 10, 0, 120, 5)
        if not ok:
            return
        try:
            self._client.create_appointment_service(
                self._organization_id, name.strip(), duration, buffer
            )
            self.refresh()
        except Exception:
            self.error.setText("서비스 추가에 실패했습니다.")


class SchedulePage(QTabWidget):
    def __init__(
        self,
        task_client: Any,
        appointment_client: Any,
        organization_id: UUID,
        can_manage: bool,
        can_open_treatment: bool = True,
    ) -> None:
        super().__init__()
        self.tasks = TaskPage(task_client, organization_id)
        self.appointments = AppointmentPage(
            appointment_client, organization_id, can_manage, can_open_treatment
        )
        self.addTab(self.appointments, "예약")
        self.addTab(self.tasks, "할 일")
        self.currentChanged.connect(self._tab_changed)
        self._last_tab = 0

    def _tab_changed(self, index: int) -> None:
        previous = self.widget(self._last_tab)
        if index != self._last_tab and not previous.confirm_leave():
            self.blockSignals(True)
            self.setCurrentIndex(self._last_tab)
            self.blockSignals(False)
        else:
            self._last_tab = index

    def confirm_leave(self) -> bool:
        return self.currentWidget().confirm_leave()
