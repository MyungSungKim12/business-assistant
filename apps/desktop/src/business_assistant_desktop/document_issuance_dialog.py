"""Review a server-rendered treatment document and retain immutable issued copies."""

from collections.abc import Callable
from copy import deepcopy
from typing import Any, Protocol
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.document_consent_dialog import DocumentConsentDialog
from business_assistant_desktop.treatment_lifecycle import local_time

FIELD_NAMES = {
    "customer.name": "고객 이름",
    "customer.phone": "고객 연락처",
    "customer.birth_date": "고객 생년월일",
    "treatment.name": "시술명",
    "treatment.date": "시술일",
    "treatment.practitioner": "담당자",
    "treatment.amount": "예정 금액",
    "treatment.consultation_goal": "상담 목표",
    "malformed_placeholder": "잘못된 중괄호 표시",
    "": "빈 자동 채움 표시",
}


def source_label(snapshot: object) -> str:
    if not isinstance(snapshot, dict):
        return "원본 정보 표시 불가"
    customer, treatment = snapshot.get("customer"), snapshot.get("treatment")
    if not isinstance(customer, dict) or not isinstance(treatment, dict):
        return "원본 정보 표시 불가"
    return (
        f"고객 {customer.get('name') or '미등록'} · 연락처 {customer.get('phone') or '미등록'}\n"
        f"시술 {treatment.get('name') or '미등록'} · 시술일 {treatment.get('date') or '미등록'}"
    )


class IssuanceClient(Protocol):
    def list_document_consent_events(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
    ) -> list[dict[str, object]]: ...
    def record_document_consent_event(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]: ...
    def list_document_templates(self, organization_id: UUID) -> list[Any]: ...
    def preview_treatment_document(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        template_id: UUID,
    ) -> dict[str, object]: ...
    def issue_treatment_document(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]: ...
    def list_issued_treatment_documents(
        self,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
    ) -> list[dict[str, object]]: ...


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


class DocumentIssuanceDialog(QDialog):
    def __init__(
        self,
        client: IssuanceClient,
        organization_id: UUID,
        customer_id: UUID,
        treatment_id: UUID,
        *,
        can_manage: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id = client, organization_id
        self.customer_id, self.treatment_id, self.can_manage = customer_id, treatment_id, can_manage
        self.busy = False
        self.ready = False
        self.preview: dict[str, object] | None = None
        self.pending: dict[str, object] | None = None
        self.issued: list[dict[str, object]] = []
        self._worker: _Work | None = None
        self._consent_dialog: DocumentConsentDialog | None = None
        self.setWindowTitle("시술 문서 · 발행 및 이력")
        self.setModal(True)
        self.resize(940, 720)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        heading = QLabel("고객·시술 문서")
        heading.setObjectName("page-title")
        layout.addWidget(heading)
        layout.addWidget(QLabel("고객 정보와 시술 내용을 검토하고 발행 당시의 문서를 보관하세요."))
        note = QLabel(
            "발행만으로 동의가 완료되지는 않습니다. 서명 상태는 발행본별 이력에서 확인하세요."
        )
        note.setWordWrap(True)
        layout.addWidget(note)
        self.tabs = QTabWidget()
        review_tab = QWidget()
        review_layout = QVBoxLayout(review_tab)
        toolbar = QHBoxLayout()
        self.template_combo = QComboBox()
        self.template_combo.addItem("게시된 서식 선택", None)
        self.preview_button = QPushButton("최신 정보로 미리보기")
        toolbar.addWidget(self.template_combo, 1)
        toolbar.addWidget(self.preview_button)
        review_layout.addLayout(toolbar)
        self.preview_info = QLabel("서식을 선택하면 고객·시술 정보가 자동으로 채워집니다.")
        self.preview_info.setTextFormat(Qt.TextFormat.PlainText)
        self.preview_info.setWordWrap(True)
        review_layout.addWidget(self.preview_info)
        self.preview_body = QTextEdit()
        self.preview_body.setReadOnly(True)
        self.preview_body.setPlaceholderText("발행 전 검토할 문서 내용")
        review_layout.addWidget(self.preview_body, 1)
        self.reviewed = QCheckBox("고객·시술 정보와 문서 내용을 확인했습니다.")
        review_layout.addWidget(self.reviewed)
        self.issue_button = QPushButton("검토한 내용으로 발행")
        self.issue_button.setObjectName("treatment-save")
        review_layout.addWidget(self.issue_button)
        self.tabs.addTab(review_tab, "발행 전 검토")
        history_tab = QWidget()
        history_layout = QVBoxLayout(history_tab)
        split = QSplitter()
        self.history_list = QListWidget()
        split.addWidget(self.history_list)
        detail = QWidget()
        detail_layout = QVBoxLayout(detail)
        self.history_info = QLabel("발행 이력을 불러오는 중…")
        self.history_info.setTextFormat(Qt.TextFormat.PlainText)
        self.history_info.setWordWrap(True)
        detail_layout.addWidget(self.history_info)
        self.history_body = QTextEdit()
        self.history_body.setReadOnly(True)
        detail_layout.addWidget(self.history_body, 1)
        split.addWidget(detail)
        split.setStretchFactor(1, 2)
        history_layout.addWidget(split)
        self.consent_button = QPushButton("선택한 발행본 · 서명·교부·철회")
        self.consent_button.clicked.connect(self._open_consent)
        history_layout.addWidget(self.consent_button)
        self.tabs.addTab(history_tab, "발행 이력")
        layout.addWidget(self.tabs, 1)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        footer = QHBoxLayout()
        self.reload_button = QPushButton("서식·이력 새로고침")
        self.retry_button = QPushButton("같은 발행 요청 재시도")
        self.close_button = QPushButton("닫기")
        footer.addWidget(self.reload_button)
        footer.addWidget(self.retry_button)
        footer.addStretch()
        footer.addWidget(self.close_button)
        layout.addLayout(footer)
        for button in (
            self.preview_button,
            self.issue_button,
            self.reload_button,
            self.retry_button,
            self.close_button,
        ):
            button.setAutoDefault(False)
        self.template_combo.currentIndexChanged.connect(self._selection_changed)
        self.preview_button.clicked.connect(self.load_preview)
        self.reviewed.toggled.connect(self._controls)
        self.issue_button.clicked.connect(self.issue)
        self.reload_button.clicked.connect(self.reload)
        self.retry_button.clicked.connect(self.retry_issue)
        self.close_button.clicked.connect(self.reject)
        self.history_list.currentRowChanged.connect(self._show_history)
        self.reload()

    def _controls(self) -> None:
        unlocked = not self.busy and self.pending is None
        valid = self.preview is not None and not self.preview.get("missing_fields")
        self.template_combo.setEnabled(unlocked and self.ready)
        self.preview_button.setEnabled(
            unlocked and self.ready and self.template_combo.currentData() is not None
        )
        self.reviewed.setEnabled(unlocked and valid and self.can_manage)
        self.issue_button.setEnabled(
            unlocked and valid and self.can_manage and self.reviewed.isChecked()
        )
        self.reload_button.setEnabled(unlocked)
        self.retry_button.setVisible(self.pending is not None)
        self.retry_button.setEnabled(not self.busy)
        self.history_list.setEnabled(not self.busy)
        self.consent_button.setEnabled(
            not self.busy and self.pending is None and self.history_list.currentRow() >= 0
        )

    def _selection_changed(self, _index: int) -> None:
        self.preview = None
        self.reviewed.setChecked(False)
        self.preview_body.clear()
        self.preview_info.setText("서식을 선택한 후 최신 정보로 미리보기를 눌러주세요.")
        self._controls()

    def _run(self, kind: str, operation: Callable[[], Any]) -> None:
        self.busy = True
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def reload(self) -> None:
        if self.busy or self.pending is not None:
            return
        self.ready = False
        self.preview = None
        self.reviewed.setChecked(False)
        self.preview_body.clear()
        self.status.setText("게시된 서식과 발행 이력을 불러오는 중…")

        def load() -> tuple[list[Any], list[dict[str, object]]]:
            return (
                self.client.list_document_templates(self.organization_id),
                self.client.list_issued_treatment_documents(
                    self.organization_id, self.customer_id, self.treatment_id
                ),
            )

        self._run("load", load)

    def load_preview(self) -> None:
        template = self.template_combo.currentData()
        if (
            self.busy
            or self.pending is not None
            or not self.ready
            or not isinstance(template, UUID)
        ):
            return
        self.preview = None
        self.reviewed.setChecked(False)
        self.status.setText("최신 고객·시술 정보로 문서를 준비하는 중…")
        self._run(
            "preview",
            lambda: self.client.preview_treatment_document(
                self.organization_id, self.customer_id, self.treatment_id, template
            ),
        )

    def issue(self) -> None:
        if (
            self.busy
            or self.pending is not None
            or not self.can_manage
            or self.preview is None
            or self.preview.get("missing_fields")
            or not self.reviewed.isChecked()
        ):
            return
        self.pending = {
            "template_id": str(self.template_combo.currentData()),
            "operation_id": str(uuid4()),
            "expected_preview": deepcopy(self.preview),
        }
        self.retry_issue()

    def retry_issue(self) -> None:
        if self.busy or self.pending is None or not self.can_manage:
            return
        payload = deepcopy(self.pending)
        self.status.setText("검토한 내용으로 발행본을 저장하는 중…")
        self._run(
            "issue",
            lambda: self.client.issue_treatment_document(
                self.organization_id, self.customer_id, self.treatment_id, payload
            ),
        )

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            if isinstance(error, PermissionError):
                code = 403
            if kind == "issue" and code in {400, 401, 403, 404, 409, 422}:
                self.pending = None
                self.preview = None
                self.reviewed.setChecked(False)
            messages = {
                401: "로그인이 만료되었습니다. 다시 로그인한 뒤 확인하세요.",
                403: "문서 또는 고객·시술 접근 권한이 없습니다.",
                404: "고객·시술 또는 서식이 없습니다. 최신 목록을 확인하세요.",
                409: "검토 중 원본 정보나 서식이 바뀌었습니다. 미리보기를 다시 불러와 검토하세요.",
                422: "서식의 게시 상태, 누락 항목과 자동 채움 표시를 확인하세요.",
            }
            fallback = "서식·이력을 불러오지 못했습니다. 새로고침으로 다시 시도하세요."
            if kind == "issue":
                fallback = (
                    "발행 결과를 확인하지 못했습니다. 같은 요청 재시도로 중복 없이 확인하세요."
                )
            elif kind == "preview":
                fallback = "미리보기를 불러오지 못했습니다. 다시 시도하세요."
            self.status.setText(messages.get(code, fallback))
            if kind == "load":
                self.history_info.setText("이력 조회 실패 · 새로고침이 필요합니다.")
            elif kind == "preview" or (kind == "issue" and self.pending is None):
                self.preview_info.setText("이전 미리보기 · 발행 불가. 최신 정보를 다시 불러오세요.")
        elif kind == "load":
            templates, self.issued = result
            self.template_combo.blockSignals(True)
            self.template_combo.clear()
            self.template_combo.addItem("게시된 서식 선택", None)
            for template in templates:
                if template.status == "published":
                    self.template_combo.addItem(
                        f"{template.name} · v{template.version}", template.id
                    )
            self.template_combo.blockSignals(False)
            self.ready = True
            self._render_history()
            self.preview_info.setText("서식을 선택한 후 최신 정보로 미리보기를 눌러주세요.")
            self.status.setText(
                "게시된 서식이 없습니다. 문서 메뉴에서 서식을 게시하세요."
                if self.template_combo.count() == 1
                else "발행할 서식을 선택하세요."
            )
        elif kind == "preview":
            self.preview = result
            self.preview_body.setPlainText(str(result["content"]))
            missing = result["missing_fields"]
            text = f"{result['title']} · 서식 v{result['template_version']}"
            text += "\n" + source_label(result.get("source_snapshot"))
            if missing:
                text += "\n발행 불가 · 누락/미지원 항목: " + ", ".join(
                    FIELD_NAMES.get(key, key) for key in missing
                )
            self.preview_info.setText(text)
            self.status.setText(
                "표시된 내용과 고객·시술 정보를 확인하세요."
                if not missing
                else "원본 정보나 서식을 보완한 뒤 다시 미리보기 하세요."
            )
        elif kind == "issue":
            self.pending = None
            self.preview = None
            self.reviewed.setChecked(False)
            self.issued = [result] + [row for row in self.issued if row["id"] != result["id"]]
            self._render_history()
            self.history_list.setCurrentRow(0)
            self.tabs.setCurrentIndex(1)
            self.preview_info.setText(
                "발행본 저장 완료 · 다시 발행하려면 최신 미리보기를 불러오세요."
            )
            self.status.setText(
                "발행 당시의 내용과 서식 버전을 보관했습니다. 서명은 아직 확인되지 않았습니다."
            )
        self._controls()

    def _render_history(self) -> None:
        self.history_list.clear()
        self.history_body.clear()
        for row in self.issued:
            self.history_list.addItem(
                f"{row['title']} · v{row['template_version']}\n{local_time(str(row['issued_at']))}"
            )
        self.history_info.setText(
            "발행본을 선택하세요." if self.issued else "이 시술에 발행한 문서가 없습니다."
        )

    def _show_history(self, index: int) -> None:
        self._controls()
        if not 0 <= index < len(self.issued):
            return
        row = self.issued[index]
        self.history_body.setPlainText(str(row["content"]))
        self.history_info.setText(
            f"{row['title']} · 서식 v{row['template_version']} · 발행본 · 서명 상태 별도 확인\n"
            f"발행일 {local_time(str(row['issued_at']))} · 발행자 ID {row['issued_by']}"
            + "\n"
            + source_label(row.get("source_snapshot"))
        )

    def confirm_leave(self) -> bool:
        if (
            self._consent_dialog is not None
            and self._consent_dialog.isVisible()
            and not self._consent_dialog.confirm_leave()
        ):
            return False
        if self.busy:
            self.status.setText("요청이 끝난 뒤 닫아주세요.")
            return False
        if self.pending is None and (not self.can_manage or not self.reviewed.isChecked()):
            return True
        text = "검토한 문서를 발행하지 않고 닫으시겠습니까?"
        if self.pending:
            text = (
                "발행 결과가 아직 확인되지 않았습니다. "
                "재시도하면 중복 없이 확인할 수 있습니다. 닫으시겠습니까?"
            )
        return (
            QMessageBox.question(
                self,
                "문서 발행",
                text,
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def _open_consent(self) -> None:
        index = self.history_list.currentRow()
        if self.busy or self.pending is not None or not 0 <= index < len(self.issued):
            return
        if self._consent_dialog is not None and self._consent_dialog.isVisible():
            self._consent_dialog.raise_()
            return
        self._consent_dialog = DocumentConsentDialog(
            self.client,
            self.organization_id,
            self.customer_id,
            self.treatment_id,
            self.issued[index],
            can_manage=self.can_manage,
            parent=self,
        )
        self._consent_dialog.show()

    def accept(self) -> None:
        if self.confirm_leave():
            super().accept()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            super().reject()
            event.accept()
        else:
            event.ignore()
