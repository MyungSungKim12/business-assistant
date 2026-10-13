"""Appointment room/equipment catalog and per-service requirement editor."""

from typing import Any
from uuid import UUID, uuid4

from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

_KIND_LABEL = {"room": "공간", "equipment": "장비"}


class AppointmentResourceDialog(QDialog):
    def __init__(self, client: Any, organization_id: UUID, parent: Any = None) -> None:
        super().__init__(parent)
        self._client = client
        self._organization_id = organization_id
        self._resources: list[dict[str, object]] = []
        self._services: list[dict[str, object]] = []
        self._resource_baseline: tuple[object, ...] = ()
        self._requirement_baseline: tuple[int, int] = (0, 0)
        self._last_service_index = -1
        self._pending_create: tuple[tuple[str, str], UUID] | None = None
        self._pending_toggle: tuple[tuple[object, ...], str] | None = None
        self._pending_requirements: tuple[tuple[object, ...], str] | None = None
        self.setWindowTitle("예약 공간·장비")
        self.resize(720, 620)

        self.resource_table = QTableWidget(0, 3)
        self.resource_table.setHorizontalHeaderLabels(["구분", "이름", "상태"])
        self.resource_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.resource_table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.resource_table.itemSelectionChanged.connect(self._selection_changed)
        self.resource_name = QLineEdit()
        self.resource_name.setPlaceholderText("예: 관리실 1, 레이저 1")
        self.resource_kind = QComboBox()
        self.resource_kind.addItem("공간", "room")
        self.resource_kind.addItem("장비", "equipment")
        self.add_button = QPushButton("자원 추가")
        self.add_button.setProperty("role", "primary")
        self.toggle_button = QPushButton("사용 중지")
        self.toggle_button.setEnabled(False)
        self.add_button.clicked.connect(self._add_resource)
        self.toggle_button.clicked.connect(self._toggle_resource)

        add_form = QFormLayout()
        add_form.addRow("이름", self.resource_name)
        add_form.addRow("구분", self.resource_kind)
        add_row = QHBoxLayout()
        add_row.addWidget(self.add_button)
        add_row.addWidget(self.toggle_button)
        add_row.addStretch()

        self.service = QComboBox()
        self.service.currentIndexChanged.connect(self._service_changed)
        self.room_quantity = QSpinBox()
        self.room_quantity.setRange(0, 10)
        self.equipment_quantity = QSpinBox()
        self.equipment_quantity.setRange(0, 10)
        requirement_form = QFormLayout()
        requirement_form.addRow("서비스", self.service)
        requirement_form.addRow("필요 공간 수", self.room_quantity)
        requirement_form.addRow("필요 장비 수", self.equipment_quantity)
        self.save_requirements_button = QPushButton("서비스 자원 기준 저장")
        self.save_requirements_button.setProperty("role", "primary")
        self.save_requirements_button.clicked.connect(self._save_requirements)
        self.error = QLabel()
        self.error.setObjectName("error")
        self.error.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("예약 공간·장비"))
        layout.addWidget(self.resource_table, 1)
        layout.addLayout(add_form)
        layout.addLayout(add_row)
        layout.addWidget(QLabel("서비스별 필수 자원"))
        layout.addLayout(requirement_form)
        layout.addWidget(self.save_requirements_button)
        layout.addWidget(self.error)
        self._resource_baseline = self._resource_draft()
        self.refresh()

    def _resource_draft(self) -> tuple[object, ...]:
        return (self.resource_name.text(), self.resource_kind.currentData())

    def _requirement_draft(self) -> tuple[int, int]:
        return (self.room_quantity.value(), self.equipment_quantity.value())

    def _confirm_requirement_discard(self) -> bool:
        if self._requirement_draft() == self._requirement_baseline:
            return True
        answer = QMessageBox.question(
            self,
            "작성 중인 자원 기준",
            "저장하지 않은 서비스 자원 기준을 버릴까요?",
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if answer != QMessageBox.StandardButton.Discard:
            return False
        self._pending_requirements = None
        return True

    def _can_close(self) -> bool:
        if (
            self._resource_draft() == self._resource_baseline
            and self._requirement_draft() == self._requirement_baseline
        ):
            return True
        answer = QMessageBox.question(
            self,
            "작성 중인 공간·장비",
            "저장하지 않은 입력을 버리고 닫을까요?",
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        return answer == QMessageBox.StandardButton.Discard

    def refresh(self) -> None:
        try:
            self._resources = list(
                self._client.list_appointment_resources(self._organization_id)
            )
            self._services = list(self._client.list_appointment_services(self._organization_id))
        except Exception:
            self.error.setText("공간·장비 정보를 불러오지 못했습니다.")
            return
        self.resource_table.setRowCount(0)
        for resource in self._resources:
            row = self.resource_table.rowCount()
            self.resource_table.insertRow(row)
            values = [
                _KIND_LABEL.get(str(resource.get("kind")), str(resource.get("kind"))),
                str(resource.get("name", "")),
                "사용 중" if resource.get("is_active") else "사용 중지",
            ]
            for column, value in enumerate(values):
                self.resource_table.setItem(row, column, QTableWidgetItem(value))
        current_service = self.service.currentData()
        self.service.blockSignals(True)
        self.service.clear()
        for service in self._services:
            self.service.addItem(str(service.get("name", "서비스")), str(service["id"]))
        if current_service is not None:
            index = self.service.findData(str(current_service))
            if index >= 0:
                self.service.setCurrentIndex(index)
        self.service.blockSignals(False)
        self.toggle_button.setEnabled(False)
        self._load_requirements()
        self._last_service_index = self.service.currentIndex()
        self.error.clear()

    def _selection_changed(self) -> None:
        row = self.resource_table.currentRow()
        selected = self._resources[row] if 0 <= row < len(self._resources) else None
        self.toggle_button.setEnabled(selected is not None)
        if selected is not None:
            self.toggle_button.setText("사용 중지" if selected.get("is_active") else "다시 사용")

    def _add_resource(self) -> None:
        name = self.resource_name.text().strip()
        if not name:
            self.error.setText("공간 또는 장비 이름을 입력하세요.")
            return
        fingerprint = (name, str(self.resource_kind.currentData()))
        if self._pending_create is None or self._pending_create[0] != fingerprint:
            self._pending_create = (fingerprint, uuid4())
        try:
            self._client.create_appointment_resource(
                self._organization_id,
                name,
                str(self.resource_kind.currentData()),
                self._pending_create[1],
            )
        except Exception:
            self.error.setText("공간·장비 추가에 실패했습니다. 입력은 유지됩니다.")
            return
        self._pending_create = None
        self.resource_name.clear()
        self._resource_baseline = self._resource_draft()
        self.refresh()

    def _toggle_resource(self) -> None:
        row = self.resource_table.currentRow()
        if row < 0 or row >= len(self._resources):
            return
        selected = self._resources[row]
        fingerprint = (
            selected["id"],
            selected["version"],
            not bool(selected["is_active"]),
        )
        if self._pending_toggle is None or self._pending_toggle[0] != fingerprint:
            self._pending_toggle = (fingerprint, str(uuid4()))
        try:
            self._client.update_appointment_resource(
                self._organization_id,
                UUID(str(selected["id"])),
                {
                    "name": selected["name"],
                    "is_active": not bool(selected["is_active"]),
                    "expected_version": selected["version"],
                    "operation_id": self._pending_toggle[1],
                },
            )
        except Exception:
            self.error.setText("사용 상태 변경에 실패했습니다. 예약 사용 여부를 확인하세요.")
            return
        self._pending_toggle = None
        self.refresh()

    def _selected_service(self) -> dict[str, object] | None:
        service_id = self.service.currentData()
        return next(
            (item for item in self._services if str(item.get("id")) == str(service_id)), None
        )

    def _load_requirements(self) -> None:
        selected = self._selected_service()
        self.room_quantity.setValue(0)
        self.equipment_quantity.setValue(0)
        self.save_requirements_button.setEnabled(selected is not None)
        if selected is None:
            self._requirement_baseline = self._requirement_draft()
            return
        try:
            requirements = self._client.list_appointment_service_resource_requirements(
                self._organization_id, UUID(str(selected["id"]))
            )
        except Exception:
            self.error.setText("서비스 자원 기준을 불러오지 못했습니다.")
            return
        quantities = {str(item["kind"]): int(item["quantity"]) for item in requirements}
        self.room_quantity.setValue(quantities.get("room", 0))
        self.equipment_quantity.setValue(quantities.get("equipment", 0))
        self._requirement_baseline = self._requirement_draft()

    def _service_changed(self, index: int) -> None:
        if not self._confirm_requirement_discard():
            self.service.blockSignals(True)
            self.service.setCurrentIndex(self._last_service_index)
            self.service.blockSignals(False)
            return
        self._last_service_index = index
        self._pending_requirements = None
        self._load_requirements()

    def _save_requirements(self) -> None:
        selected = self._selected_service()
        if selected is None:
            return
        requirements = []
        if self.room_quantity.value():
            requirements.append({"kind": "room", "quantity": self.room_quantity.value()})
        if self.equipment_quantity.value():
            requirements.append(
                {"kind": "equipment", "quantity": self.equipment_quantity.value()}
            )
        fingerprint = (
            str(selected["id"]),
            selected.get("resource_version", 1),
            tuple((item["kind"], item["quantity"]) for item in requirements),
        )
        if self._pending_requirements is None or self._pending_requirements[0] != fingerprint:
            self._pending_requirements = (fingerprint, str(uuid4()))
        try:
            self._client.replace_appointment_service_resource_requirements(
                self._organization_id,
                UUID(str(selected["id"])),
                {
                    "requirements": requirements,
                    "expected_version": selected.get("resource_version", 1),
                    "operation_id": self._pending_requirements[1],
                },
            )
        except Exception:
            self.error.setText("서비스 자원 기준 저장에 실패했습니다. 입력은 유지됩니다.")
            return
        self._pending_requirements = None
        self.refresh()

    def reject(self) -> None:
        if self._can_close():
            super().reject()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self._can_close():
            event.accept()
        else:
            event.ignore()

