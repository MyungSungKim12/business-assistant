"""On-site handwritten evidence and append-only manual delivery/withdrawal records."""

import json
from collections.abc import Callable
from copy import deepcopy
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
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.signature_pad import SignaturePad
from business_assistant_desktop.treatment_lifecycle import local_time

LABELS = {"sign": "현장 손서명", "deliver": "교부 확인 기록", "revoke": "철회 기록"}
METHODS = {"paper": "종이 교부", "email": "외부 이메일", "sms": "외부 문자", "other": "기타"}


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


class DocumentConsentDialog(QDialog):
    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        document: dict[str, object],
        *,
        can_manage: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.scope = (
            client,
            (organization_id, customer_id, treatment_id, UUID(str(document["id"]))),
        )
        self.can_manage = can_manage
        self.events: list[dict[str, Any]] = []
        self.pending: dict[str, object] | None = None
        self.busy, self.loaded, self.conflicted = False, False, False
        self._worker: _Work | None = None
        self._baseline = ""
        self.setWindowTitle("발행본 · 서명·교부·철회")
        self.setModal(True)
        self.resize(900, 820)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        title = QLabel(f"{document['title']} · 서식 v{document['template_version']}")
        title.setTextFormat(Qt.TextFormat.PlainText)
        title.setObjectName("section-heading")
        title.setWordWrap(True)
        layout.addWidget(title)
        self.state = QLabel("이력을 불러오는 중…")
        self.state.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.state)
        self.body = QTextEdit()
        self.body.setReadOnly(True)
        self.body.setPlainText(str(document["content"]))
        self.body.setMinimumHeight(120)
        layout.addWidget(self.body, 1)
        tabs = QTabWidget()
        self.signer = QLineEdit()
        self.signer.setMaxLength(100)
        self.pad = SignaturePad()
        self.clear_button = QPushButton("서명 지우기")
        self.clear_button.clicked.connect(self.pad.clear)
        self.sign_confirm = QCheckBox("위 발행본을 읽은 고객이 직접 서명한 것을 확인했습니다.")
        sign_page = QWidget()
        sign_box = QVBoxLayout(sign_page)
        sign_box.addWidget(QLabel("현장 손서명 보관 · 별도 본인인증은 수행하지 않습니다."))
        form = QFormLayout()
        form.addRow("서명자 이름", self.signer)
        sign_box.addLayout(form)
        sign_box.addWidget(self.pad)
        sign_box.addWidget(self.clear_button)
        sign_box.addWidget(self.sign_confirm)
        self.buttons: dict[str, QPushButton] = {}
        self.buttons["sign"] = QPushButton("이 발행본에 손서명 저장")
        self.buttons["sign"].setProperty("role", "primary")
        sign_box.addWidget(self.buttons["sign"])
        tabs.addTab(sign_page, "손서명")
        delivery_page = QWidget()
        delivery_box = QVBoxLayout(delivery_page)
        delivery_box.addWidget(
            QLabel("외부에서 실제 교부한 사실을 기록합니다. 이 버튼은 메시지를 발송하지 않습니다.")
        )
        self.method = QComboBox()
        for key, label in METHODS.items():
            self.method.addItem(label, key)
        self.recipient = QLineEdit()
        self.recipient.setMaxLength(200)
        self.reference = QLineEdit()
        self.reference.setMaxLength(500)
        self.note = QTextEdit()
        self.note.setAcceptRichText(False)
        delivery_form = QFormLayout()
        delivery_form.addRow("교부 방법", self.method)
        delivery_form.addRow("수령인", self.recipient)
        delivery_form.addRow("확인 자료·참조", self.reference)
        delivery_form.addRow("기록 메모", self.note)
        delivery_box.addLayout(delivery_form)
        self.delivery_confirm = QCheckBox(
            "해당 발행본을 수령인에게 실제로 교부한 사실을 확인했습니다."
        )
        delivery_box.addWidget(self.delivery_confirm)
        self.buttons["deliver"] = QPushButton("교부 확인 기록 추가")
        self.buttons["deliver"].setProperty("role", "primary")
        delivery_box.addWidget(self.buttons["deliver"])
        tabs.addTab(delivery_page, "교부 확인")
        revoke_page = QWidget()
        revoke_box = QVBoxLayout(revoke_page)
        revoke_box.addWidget(
            QLabel("철회 후에도 원문·손서명·교부 기록은 보존됩니다. 철회는 되돌릴 수 없습니다.")
        )
        self.reason = QTextEdit()
        self.reason.setAcceptRichText(False)
        self.reason.setPlaceholderText("고객의 철회 요청 사유와 확인 경위를 입력하세요.")
        revoke_box.addWidget(self.reason)
        self.revoke_confirm = QCheckBox("고객의 철회 요청을 확인했습니다.")
        revoke_box.addWidget(self.revoke_confirm)
        self.buttons["revoke"] = QPushButton("철회 기록 남기기")
        self.buttons["revoke"].setProperty("role", "danger")
        revoke_box.addWidget(self.buttons["revoke"])
        tabs.addTab(revoke_page, "철회")
        history_page = QWidget()
        history_box = QVBoxLayout(history_page)
        self.timeline = QListWidget()
        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        history_box.addWidget(self.timeline)
        history_box.addWidget(self.detail)
        tabs.addTab(history_page, "전체 이력")
        layout.addWidget(tabs, 2)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        footer = QHBoxLayout()
        self.reload_button = QPushButton("이력 새로고침")
        self.retry_button = QPushButton("같은 요청 재시도")
        close = QPushButton("닫기")
        footer.addWidget(self.reload_button)
        footer.addWidget(self.retry_button)
        footer.addStretch()
        footer.addWidget(close)
        layout.addLayout(footer)
        self.reload_button.clicked.connect(self.reload)
        self.retry_button.clicked.connect(self.retry)
        close.clicked.connect(self.reject)
        self.timeline.currentRowChanged.connect(self._show_event)
        for action, button in self.buttons.items():
            button.clicked.connect(lambda _checked=False, action=action: self.save(action))
        for button in [
            *self.buttons.values(),
            self.reload_button,
            self.retry_button,
            self.clear_button,
            close,
        ]:
            button.setAutoDefault(False)
        self._baseline = self._inputs()
        self.reload()

    def _inputs(self) -> str:
        return json.dumps(
            [
                self.signer.text(),
                self.pad.strokes(),
                self.sign_confirm.isChecked(),
                self.method.currentData(),
                self.recipient.text(),
                self.reference.text(),
                self.note.toPlainText(),
                self.delivery_confirm.isChecked(),
                self.reason.toPlainText(),
                self.revoke_confirm.isChecked(),
            ],
            ensure_ascii=False,
            sort_keys=True,
        )

    def dirty(self) -> bool:
        return self.can_manage and self._inputs() != self._baseline

    def _controls(self) -> None:
        signed = any(row["action"] == "sign" for row in self.events)
        revoked = any(row["action"] == "revoke" for row in self.events)
        enabled = (
            self.loaded
            and self.can_manage
            and not self.busy
            and self.pending is None
            and not self.conflicted
            and not revoked
        )
        for widget in (
            self.signer,
            self.pad,
            self.clear_button,
            self.sign_confirm,
            self.buttons["sign"],
        ):
            widget.setEnabled(enabled and not signed)
        for widget in (
            self.method,
            self.recipient,
            self.reference,
            self.note,
            self.delivery_confirm,
            self.reason,
            self.revoke_confirm,
            self.buttons["deliver"],
            self.buttons["revoke"],
        ):
            widget.setEnabled(enabled and signed)
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
        if self.busy or self.pending is not None or not self.confirm_leave():
            return
        self.status.setText("최신 이력을 불러오는 중…")
        self._run("load", lambda: self.client.list_document_consent_events(*self.scope))

    def save(self, action: str) -> None:
        if self.busy or self.pending or not self.loaded or not self.can_manage or self.conflicted:
            return
        if action not in self.buttons or not self.buttons[action].isEnabled():
            return
        values: dict[str, object]
        if action == "sign":
            if (
                not self.signer.text().strip()
                or not self.pad.has_ink()
                or not self.sign_confirm.isChecked()
            ):
                self.status.setText("서명자 이름, 손서명과 확인 체크가 필요합니다.")
                return
            values = {
                "signer_name": self.signer.text().strip(),
                "strokes": self.pad.strokes(),
                "confirmed": True,
            }
        elif action == "deliver":
            if (
                not self.recipient.text().strip()
                or not self.delivery_confirm.isChecked()
                or len(self.note.toPlainText()) > 2000
            ):
                self.status.setText(
                    "수령인과 교부 확인 체크가 필요합니다. 메모는 2,000자 이내입니다."
                )
                return
            values = {
                "method": self.method.currentData(),
                "recipient": self.recipient.text().strip(),
                "reference": self.reference.text(),
                "note": self.note.toPlainText(),
                "confirmed": True,
            }
        else:
            reason = self.reason.toPlainText().strip()
            if not reason or len(reason) > 2000 or not self.revoke_confirm.isChecked():
                self.status.setText("철회 사유(2,000자 이내)와 요청 확인 체크가 필요합니다.")
                return
            values = {"reason": reason, "confirmed": True}
        self.pending = {
            "action": action,
            "values": values,
            "expected_revision": max((int(e["revision"]) for e in self.events), default=0),
            "operation_id": str(uuid4()),
        }
        self.retry()

    def retry(self) -> None:
        if self.busy or self.pending is None:
            return
        payload = deepcopy(self.pending)
        self.status.setText("기록을 저장하는 중…")
        self._run("save", lambda: self.client.record_document_consent_event(*self.scope, payload))

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            if isinstance(error, PermissionError):
                code = 403
            if code in {400, 401, 403, 404, 409, 422}:
                self.pending = None
            self.conflicted = code == 409
            self.status.setText(
                {
                    409: "다른 기록이 추가되었습니다. 입력을 보존한 뒤 이력을 새로고침하세요.",
                    403: "기록 접근 또는 변경 권한이 없습니다. 입력은 유지됩니다.",
                    422: "입력 형식과 확인 체크를 확인하세요. 입력은 유지됩니다.",
                }.get(code, "요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.")
            )
        else:
            if kind == "save":
                self.events = self.events + [result]
                self.pending = None
            else:
                self.events = result
            self.loaded, self.conflicted = True, False
            self._render(result["action"] if kind == "save" else None)
            self.status.setText(
                "기록을 저장했습니다." if kind == "save" else "최신 이력을 확인했습니다."
            )
        self._controls()

    def _render(self, saved_action: str | None = None) -> None:
        baseline = json.loads(self._baseline) if saved_action else None
        signed = next((event for event in self.events if event["action"] == "sign"), None)
        revoked = any(event["action"] == "revoke" for event in self.events)
        self.state.setText(
            "철회됨 · 원문과 손서명 보존"
            if revoked
            else "현장 손서명 기록됨 · 별도 본인인증 미수행"
            if signed
            else "서명 미확인"
        )
        self.signer.setText(signed["values"]["signer_name"] if signed else "")
        self.pad.set_strokes(signed["values"]["strokes"] if signed else [])
        if saved_action in {None, "sign"}:
            self.sign_confirm.setChecked(False)
        if saved_action in {None, "deliver"}:
            self.delivery_confirm.setChecked(False)
            self.recipient.clear()
            self.reference.clear()
            self.note.clear()
        if saved_action in {None, "revoke"}:
            self.revoke_confirm.setChecked(False)
            self.reason.clear()
        self.timeline.clear()
        for event in self.events:
            timestamp = local_time(event["occurred_at"])
            self.timeline.addItem(f"{event['revision']}. {LABELS[event['action']]} · {timestamp}")
        if baseline is not None:
            current = json.loads(self._inputs())
            indexes = {"sign": range(0, 3), "deliver": range(3, 8), "revoke": range(8, 10)}
            for index in indexes[str(saved_action)]:
                baseline[index] = current[index]
            self._baseline = json.dumps(baseline, ensure_ascii=False, sort_keys=True)
        else:
            self._baseline = self._inputs()
        if self.events:
            self.timeline.setCurrentRow(len(self.events) - 1)

    def _show_event(self, index: int) -> None:
        if not 0 <= index < len(self.events):
            return
        event = self.events[index]
        values = event["values"]
        text = (
            f"{LABELS[event['action']]}\n기록자 ID: {event['actor_id']}\n"
            f"기록 시각: {local_time(event['occurred_at'])}"
        )
        if event["action"] == "sign":
            text += f"\n서명자: {values['signer_name']}\n손서명은 손서명 탭에서 조회할 수 있습니다."
        elif event["action"] == "deliver":
            text += (
                f"\n방법: {METHODS[values['method']]}\n수령인: {values['recipient']}"
                f"\n참조: {values['reference']}\n메모: {values['note']}"
            )
        else:
            text += f"\n철회 사유: {values['reason']}"
        self.detail.setPlainText(text)

    def confirm_leave(self) -> bool:
        if self.busy:
            self.status.setText("요청 처리 후 닫아주세요.")
            return False
        if not self.dirty() and self.pending is None:
            return True
        text = "저장하지 않은 입력과 손서명을 버리시겠습니까?"
        if self.pending:
            text += "\n저장 결과가 불명확합니다. 같은 요청 재시도로 결과를 확인할 수 있습니다."
        return (
            QMessageBox.question(
                self,
                "작성 중인 기록",
                text,
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
