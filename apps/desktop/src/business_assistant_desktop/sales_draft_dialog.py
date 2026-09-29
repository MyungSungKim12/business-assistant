"""Review a treatment handoff without recording payment or realized revenue."""

import json
import re
from collections.abc import Callable
from copy import deepcopy
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.api_client import Treatment

CONSENT = {
    "signed": "손서명 기록 있음",
    "unsigned": "서명 미확인",
    "revoked": "철회 기록 있음",
    "not_linked": "동의 문서 미연결",
}


class _Signals(QObject):
    finished = Signal(object)


class _Work(QRunnable):
    def __init__(self, kind: str, operation: Callable[[], Any]) -> None:
        super().__init__()
        self.kind, self.operation = kind, operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((self.kind, result, error))


def draft_text(row: dict[str, Any]) -> str:
    snapshot = row.get("source_snapshot", {})
    customer, treatment, consent = (
        snapshot.get(key, {}) for key in ("customer", "treatment", "consent")
    )
    return (
        f"결제 초안 · 미수납\n고객: {customer.get('name', '')}\n"
        f"청구 항목: {row.get('description', '')}\n검토 금액: {row.get('amount', '')}\n"
        f"담당자: {treatment.get('practitioner', '')}\n시술 버전: {treatment.get('version', '')}\n"
        f"동의 상태(전달 당시): {CONSENT.get(consent.get('status', ''), '기록 확인 필요')}\n"
        f"서식 버전: {consent.get('template_version') or '미연결'}\n"
        f"예외 사유: {snapshot.get('exception_reason', '')}\n"
        f"중단·부분 청구 사유: {snapshot.get('partial_reason', '')}\n"
        f"초안 ID: {row.get('id', '')}\n작성 시각: {row.get('created_at', '')}\n\n"
        "아직 수납하거나 매출로 확정한 거래가 아닙니다. 전달 후 원본 변경은 자동 반영되지 않습니다."
    )


class SalesDraftDialog(QDialog):
    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        record: Treatment,
        *,
        can_manage: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id, self.record = client, organization_id, record
        self.can_manage = can_manage
        self.busy, self.ready = False, False
        self.preview: dict[str, Any] | None = None
        self.pending: dict[str, object] | None = None
        self.existing: dict[str, Any] | None = None
        self._worker: _Work | None = None
        self.setModal(True)
        self.setWindowTitle("시술 명세 → 결제 초안")
        self.resize(760, 760)
        layout = QVBoxLayout(self)
        heading = QLabel("실제 청구할 시술 내용을 검토하세요.")
        layout.addWidget(heading)
        explanation = QLabel(
            "초안 전달은 수납·매출 확정이 아닙니다. 같은 시술에서는 하나의 초안만 생성됩니다."
        )
        explanation.setWordWrap(True)
        layout.addWidget(explanation)
        self.description = QLineEdit(record.treatment_name if record.status == "completed" else "")
        self.description.setMaxLength(200)
        self.amount = QLineEdit(
            str(record.amount) if record.status == "completed" and record.amount is not None else ""
        )
        self.amount.setPlaceholderText("실제 청구 검토 금액 · 0 가능")
        self.documents = QComboBox()
        self.documents.addItem("동의 문서 미연결", None)
        self.exception_reason = QTextEdit()
        self.exception_reason.setAcceptRichText(False)
        self.exception_reason.setMaximumHeight(66)
        self.exception_reason.setPlaceholderText(
            "유효한 서명 문서가 없으면 예외 사유를 기록하세요."
        )
        self.partial_reason = QTextEdit()
        self.partial_reason.setAcceptRichText(False)
        self.partial_reason.setMaximumHeight(66)
        self.partial_reason.setPlaceholderText("중단 시 실제 수행 범위와 청구 사유 필수")
        form = QFormLayout()
        form.addRow("청구 항목", self.description)
        form.addRow("검토 금액", self.amount)
        form.addRow("연결할 발행본", self.documents)
        form.addRow("동의 예외 사유", self.exception_reason)
        form.addRow("부분 수행·청구 사유", self.partial_reason)
        layout.addLayout(form)
        self.preview_button = QPushButton("최신 시술·동의 상태로 검토")
        layout.addWidget(self.preview_button)
        self.result = QTextEdit()
        self.result.setReadOnly(True)
        layout.addWidget(self.result, 1)
        self.confirmed = QCheckBox("실제 수행 항목·검토 금액·동의 상태와 예외 사유를 확인했습니다.")
        layout.addWidget(self.confirmed)
        self.create_button = QPushButton("결제 초안으로 전달")
        layout.addWidget(self.create_button)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        footer = QHBoxLayout()
        self.reload_button = QPushButton("기존 초안·문서 새로고침")
        self.retry_button = QPushButton("같은 요청 재시도")
        close = QPushButton("닫기")
        for button in (self.reload_button, self.retry_button, close):
            footer.addWidget(button)
        layout.addLayout(footer)
        for button in (
            self.preview_button,
            self.create_button,
            self.reload_button,
            self.retry_button,
            close,
        ):
            button.setAutoDefault(False)
        self.preview_button.clicked.connect(self.load_preview)
        self.create_button.clicked.connect(self.create)
        self.retry_button.clicked.connect(self.retry)
        self.reload_button.clicked.connect(self.reload)
        close.clicked.connect(self.reject)
        self.confirmed.toggled.connect(self._controls)
        self.description.textChanged.connect(self._changed)
        self.amount.textChanged.connect(self._changed)
        self.documents.currentIndexChanged.connect(self._changed)
        self.exception_reason.textChanged.connect(self._changed)
        self.partial_reason.textChanged.connect(self._changed)
        self._baseline = self._inputs()
        self.reload()

    def _values(self) -> dict[str, object]:
        return {
            "description": self.description.text().strip(),
            "amount": self.amount.text().strip(),
            "consent_document_id": str(self.documents.currentData())
            if self.documents.currentData()
            else None,
            "exception_reason": self.exception_reason.toPlainText().strip(),
            "partial_reason": self.partial_reason.toPlainText().strip(),
        }

    def _inputs(self) -> str:
        return json.dumps(self._values(), ensure_ascii=False, sort_keys=True)

    def _changed(self, *_args: Any) -> None:
        self.preview = None
        self.confirmed.setChecked(False)
        self._controls()

    def _controls(self) -> None:
        editable = (
            self.ready
            and self.can_manage
            and not self.busy
            and self.pending is None
            and self.existing is None
        )
        for widget in (
            self.description,
            self.amount,
            self.documents,
            self.exception_reason,
            self.partial_reason,
            self.preview_button,
        ):
            widget.setEnabled(editable)
        self.confirmed.setEnabled(editable and self.preview is not None)
        self.create_button.setEnabled(
            editable and self.preview is not None and self.confirmed.isChecked()
        )
        self.reload_button.setEnabled(not self.busy and self.pending is None)
        self.retry_button.setVisible(self.pending is not None)
        self.retry_button.setEnabled(not self.busy)

    def _run(self, kind: str, operation: Callable[[], Any]) -> None:
        self.busy = True
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def reload(self) -> None:
        if self.busy or self.pending is not None:
            return
        self.preview = None
        self.confirmed.setChecked(False)
        self.status.setText("기존 결제 초안과 발행 문서를 불러오는 중…")
        self._run(
            "load",
            lambda: (
                self.client.list_treatment_sale_drafts(
                    self.organization_id, self.record.customer_id, self.record.id
                ),
                self.client.list_issued_treatment_documents(
                    self.organization_id, self.record.customer_id, self.record.id
                ),
            ),
        )

    def load_preview(self) -> None:
        if self.busy or self.pending is not None or not self.ready or self.existing is not None:
            return
        v = self._values()
        amount = str(v["amount"])
        if (
            not v["description"]
            or not re.fullmatch(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?", amount)
            or Decimal(amount) >= Decimal("1000000000000")
            or len(str(v["exception_reason"])) > 2000
            or len(str(v["partial_reason"])) > 2000
            or (self.record.status == "cancelled" and not v["partial_reason"])
        ):
            self.status.setText(
                "청구 항목과 금액을 확인하세요. 중단 시 부분 수행 사유가 필요합니다. "
                "사유는 2,000자 이내입니다."
            )
            return
        self.preview = None
        self.confirmed.setChecked(False)
        self.status.setText("최신 원본과 동의 상태를 확인하는 중…")
        self._run(
            "preview",
            lambda: self.client.preview_treatment_sale_draft(
                self.organization_id, self.record.customer_id, self.record.id, v
            ),
        )

    def create(self) -> None:
        if (
            self.busy
            or self.pending is not None
            or self.preview is None
            or self.existing is not None
            or not self.can_manage
            or not self.confirmed.isChecked()
        ):
            return
        self.pending = {
            "operation_id": str(uuid4()),
            "expected_preview": deepcopy(self.preview),
            "confirmed": True,
        }
        self.retry()

    def retry(self) -> None:
        if self.busy or self.pending is None:
            return
        payload = deepcopy(self.pending)
        self.status.setText("결제 초안으로 전달하는 중…")
        self._run(
            "create",
            lambda: self.client.create_treatment_sale_draft(
                self.organization_id, self.record.customer_id, self.record.id, payload
            ),
        )

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            if code in {400, 401, 403, 404, 409, 422}:
                self.pending = None
                self.preview = None
                self.confirmed.setChecked(False)
            self.status.setText(
                {
                    409: "원본이 변경되었거나 이미 초안이 있습니다. 새로고침 후 다시 확인하세요.",
                    403: "고객·문서·결제 접근 권한을 확인하세요.",
                    422: "완료/중단 상태, 금액, 부분 수행 사유와 동의 예외 사유를 확인하세요.",
                }.get(code, "요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.")
            )
        elif kind == "load":
            rows, documents = result
            self.existing = rows[0] if rows else None
            selected = self.documents.currentData()
            self.documents.blockSignals(True)
            self.documents.clear()
            self.documents.addItem("동의 문서 미연결", None)
            for doc in documents:
                self.documents.addItem(
                    f"{doc['title']} · v{doc['template_version']}", str(doc["id"])
                )
            self.documents.setCurrentIndex(max(0, self.documents.findData(selected)))
            self.documents.blockSignals(False)
            self.ready = True
            if self.existing:
                self.result.setPlainText(draft_text(self.existing))
            self.status.setText(
                "기존 초안이 있습니다. 내용을 확인하세요."
                if rows
                else "실제 청구할 내용을 입력하고 검토하세요."
            )
        elif kind == "preview":
            self.preview = result
            line = result["line"]
            snapshot = result["source_snapshot"]
            self.result.setPlainText(
                f"고객: {snapshot.get('customer', {}).get('name', '')}\n"
                f"항목: {line['description']} · 수량: {line['quantity']}\n"
                f"검토 금액: {result['total_amount']} · 담당: {line['practitioner']}\n"
                f"동의 상태: {CONSENT.get(result['consent_status'], result['consent_status'])}\n"
                + "\n".join(result["warnings"])
                + "\n\n아직 미수납인 결제 초안입니다."
            )
            self.status.setText("실제 청구 내용과 동의 상태를 확인하고 체크하세요.")
        elif kind == "create":
            self.pending, self.preview, self.existing = None, None, result
            self.confirmed.setChecked(False)
            self._baseline = self._inputs()
            self.result.setPlainText(draft_text(result))
            self.status.setText(
                "초안을 전달했습니다. 매출·지출 메뉴의 시술 결제 초안에서 확인할 수 있습니다."
            )
        self._controls()

    def confirm_leave(self) -> bool:
        if self.busy:
            self.status.setText("처리 후 닫아주세요.")
            return False
        if self.pending is None and (not self.can_manage or self._inputs() == self._baseline):
            return True
        message = "저장하지 않은 청구 내용을 버리시겠습니까?"
        if self.pending:
            message += "\n전달 결과가 불명확합니다. 같은 요청 재시도로 확인할 수 있습니다."
        return (
            QMessageBox.question(
                self,
                "작성 중인 결제 초안",
                message,
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def accept(self) -> None:
        if self.confirm_leave():
            super().accept()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            super().reject()
            event.accept()
        else:
            event.ignore()


class SalesDraftInbox(QDialog):
    def __init__(self, client: Any, organization_id: UUID, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.client, self.organization_id = client, organization_id
        self.busy = False
        self.rows: list[dict[str, Any]] = []
        self._worker: _Work | None = None
        self.setWindowTitle("시술 결제 초안 · 미수납")
        self.resize(900, 650)
        self.setModal(True)
        layout = QVBoxLayout(self)
        layout.addWidget(
            QLabel("시술에서 전달한 검토 초안입니다. 수입 합계와 수납 실적에는 포함하지 않습니다.")
        )
        self.list = QListWidget()
        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        columns = QHBoxLayout()
        columns.addWidget(self.list, 1)
        columns.addWidget(self.detail, 2)
        layout.addLayout(columns)
        self.status = QLabel()
        layout.addWidget(self.status)
        self.reload_button = QPushButton("새로고침")
        layout.addWidget(self.reload_button)
        self.reload_button.clicked.connect(self.reload)
        self.list.currentRowChanged.connect(self._select)
        self.reload()

    def reload(self) -> None:
        if self.busy:
            return
        self.busy = True
        self.reload_button.setEnabled(False)
        self.status.setText("초안을 불러오는 중…")
        self._worker = _Work(
            "load", lambda: self.client.list_treatment_sale_drafts(self.organization_id)
        )
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        _, result, error = outcome
        self.busy = False
        self.reload_button.setEnabled(True)
        if error is not None:
            self.status.setText(
                "결제 초안을 불러오지 못했습니다. 권한과 연결을 확인하고 다시 시도하세요."
            )
            return
        self.rows = result
        self.list.clear()
        self.detail.clear()
        for row in self.rows:
            customer = row.get("source_snapshot", {}).get("customer", {}).get("name", "")
            self.list.addItem(f"{customer} · {row['description']} · {row['amount']}")
        self.status.setText(f"미수납 결제 초안 {len(self.rows)}건")

    def _select(self, index: int) -> None:
        if 0 <= index < len(self.rows):
            self.detail.setPlainText(draft_text(self.rows[index]))

    def confirm_leave(self) -> bool:
        return not self.busy

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def accept(self) -> None:
        if self.confirm_leave():
            super().accept()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            super().reject()
            event.accept()
        else:
            event.ignore()
