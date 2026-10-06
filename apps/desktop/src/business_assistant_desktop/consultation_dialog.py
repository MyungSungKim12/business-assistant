"""Consultation draft and explicit acknowledgment of the displayed customer cautions."""

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.api_client import Customer, Treatment
from business_assistant_desktop.treatment_lifecycle import local_time


def caution_snapshot(customer: Customer) -> dict[str, object]:
    return {
        "allergies": customer.allergies,
        "skin_type": customer.skin_type,
        "concerns": list(customer.concerns),
    }


def consultation_ready(record: Treatment, customer: Customer) -> bool:
    return bool(
        record.consultation_goal.strip()
        and record.cautions_acknowledged_by
        and record.cautions_acknowledged_at
        and record.cautions_snapshot == caution_snapshot(customer)
    )


class _Signals(QObject):
    finished = Signal(object)


class _Save(QRunnable):
    def __init__(self, operation: Callable[[], Treatment]) -> None:
        super().__init__()
        self.operation = operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((result, error))


class ConsultationDialog(QDialog):
    saved = Signal(object)

    def __init__(
        self,
        customer: Customer,
        record: Treatment,
        save: Callable[[dict[str, object]], Treatment],
        *,
        can_manage: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.customer, self.record, self._save_callback = customer, record, save
        self._editable = can_manage and record.status == "draft"
        self.is_saving = False
        self._conflicted = False
        self._worker: _Save | None = None
        self._pending: tuple[dict[str, object], str] | None = None
        self.setWindowTitle(f"상담 기록 · {customer.name} · {record.treatment_name}")
        self.resize(600, 620)
        self.setModal(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        heading = QLabel("상담 기록")
        heading.setObjectName("page-title")
        layout.addWidget(heading)
        self.cautions_label = QLabel(
            f"피부 타입: {customer.skin_type or '미등록'}\n"
            f"고민: {', '.join(customer.concerns) or '미등록'}\n"
            f"알레르기·주의사항: {customer.allergies or '미등록 · 상담 시 확인'}"
        )
        self.cautions_label.setObjectName("caution-panel")
        self.cautions_label.setWordWrap(True)
        self.cautions_label.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.cautions_label)
        layout.addWidget(QLabel("상담 목표 · 시술 시작 전 필수"))
        self.goal_input = QTextEdit()
        self.goal_input.setAcceptRichText(False)
        self.goal_input.setPlainText(record.consultation_goal)
        self.goal_input.setPlaceholderText(
            "고객 요청, 개선하고 싶은 점, 오늘 관리 목표 (2,000자 이내)"
        )
        self.goal_input.setReadOnly(not self._editable)
        layout.addWidget(self.goal_input, 1)
        layout.addWidget(QLabel("예정 관리 내용"))
        self.plan_input = QTextEdit()
        self.plan_input.setAcceptRichText(False)
        self.plan_input.setPlainText(record.consultation_plan)
        self.plan_input.setPlaceholderText("예상 서비스와 진행 시 유의할 내용 (5,000자 이내)")
        self.plan_input.setReadOnly(not self._editable)
        layout.addWidget(self.plan_input, 1)
        self.ack_checkbox = QCheckBox("위 고객 정보와 미등록 항목을 상담에서 직접 확인했습니다.")
        current = bool(
            record.cautions_acknowledged_at and record.cautions_acknowledged_by
        ) and record.cautions_snapshot == caution_snapshot(customer)
        self.ack_checkbox.setChecked(current)
        self.ack_checkbox.setEnabled(self._editable)
        layout.addWidget(self.ack_checkbox)
        self.confirmation_label = QLabel()
        self.confirmation_label.setWordWrap(True)
        if record.cautions_acknowledged_at:
            state = "확인 완료" if current else "고객 정보 변경 · 다시 확인 필요"
            self.confirmation_label.setText(
                f"{state} · {local_time(record.cautions_acknowledged_at)}\n"
                f"확인자 ID: {record.cautions_acknowledged_by}"
            )
        else:
            self.confirmation_label.setText("아직 주의사항을 확인하지 않았습니다.")
        layout.addWidget(self.confirmation_label)
        self.status_label = QLabel(
            "준비 상태에서만 상담을 수정할 수 있습니다."
            if not self._editable
            else "빈 초안도 저장할 수 있습니다. 시술 시작 전 목표와 주의 확인을 완료하세요."
        )
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)
        actions = QHBoxLayout()
        self.close_button = QPushButton("닫기")
        self.save_button = QPushButton("상담 초안 저장")
        self.save_button.setProperty("role", "primary")
        self.save_button.setEnabled(self._editable)
        actions.addWidget(self.close_button)
        actions.addWidget(self.save_button)
        layout.addLayout(actions)
        self.close_button.clicked.connect(self.reject)
        self.save_button.clicked.connect(self._save)
        self._baseline = self.values()

    def values(self) -> dict[str, object]:
        return {
            "goal": self.goal_input.toPlainText(),
            "plan": self.plan_input.toPlainText(),
            "acknowledge_cautions": self.ack_checkbox.isChecked(),
            "expected_cautions": caution_snapshot(self.customer),
        }

    def dirty(self) -> bool:
        return self._editable and self.values() != self._baseline

    def _save(self) -> None:
        if not self._editable or self.is_saving or self._conflicted:
            return
        values = self.values()
        if len(str(values["goal"])) > 2000 or len(str(values["plan"])) > 5000:
            self.status_label.setText(
                "상담 목표는 2,000자, 예정 관리 내용은 5,000자 이내로 입력하세요."
            )
            return
        if self._pending is None or self._pending[0] != values:
            self._pending = (values, str(uuid4()))
        payload: dict[str, object] = {
            "action": "consult",
            "expected_version": self.record.version,
            "operation_id": self._pending[1],
            "reason": "",
            "values": values,
        }
        self.is_saving = True
        self.goal_input.setReadOnly(True)
        self.plan_input.setReadOnly(True)
        self.ack_checkbox.setEnabled(False)
        self.save_button.setEnabled(False)
        self.close_button.setEnabled(False)
        self.status_label.setText("상담을 저장하는 중…")
        self._worker = _Save(lambda: self._save_callback(payload))
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        record, error = outcome
        self.is_saving = False
        self._worker = None
        self.close_button.setEnabled(True)
        self.goal_input.setReadOnly(not self._editable)
        self.plan_input.setReadOnly(not self._editable)
        self.ack_checkbox.setEnabled(self._editable)
        if error is not None:
            self._conflicted = (
                isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 409
            )
            self.save_button.setEnabled(not self._conflicted)
            self.status_label.setText(
                "고객 정보 또는 시술 기록이 변경됐습니다. "
                "입력을 보관한 뒤 닫고 상담을 다시 열어주세요."
                if self._conflicted
                else "저장에 실패했습니다. 입력은 유지됩니다. 다시 저장할 수 있습니다."
            )
            return
        self.record = record
        self._baseline = self.values()
        self.saved.emit(record)
        self.accept()

    def _can_close(self) -> bool:
        if self.is_saving:
            self.status_label.setText("저장이 끝난 뒤 닫아주세요.")
            return False
        if not self.dirty():
            return True
        choice = QMessageBox.question(
            self,
            "작성 중인 상담",
            "변경 내용을 저장할까요?",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if choice == QMessageBox.StandardButton.Save:
            self._save()
            return False
        if choice == QMessageBox.StandardButton.Discard:
            self._baseline = self.values()
            return True
        return False

    def reject(self) -> None:
        if self._can_close():
            super().reject()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self._can_close():
            event.accept()
        else:
            event.ignore()
