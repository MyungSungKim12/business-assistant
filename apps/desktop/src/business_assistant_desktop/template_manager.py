"""Versioned template editor with immutable publication preview and retry protection."""

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

STATUS = {"draft": "초안", "published": "게시됨", "retired": "폐기됨"}


class _Signals(QObject):
    finished = Signal(object)


class _Work(QRunnable):
    def __init__(self, operation: Callable[[], Any]) -> None:
        super().__init__()
        self.operation = operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result = (self.operation(), None)
        except Exception as error:
            result = (None, error)
        self.signals.finished.emit(result)


class TemplateManager(QDialog):
    changed = Signal()

    def __init__(
        self, client: Any, organization_id: Any, *, can_manage: bool, parent: QWidget | None = None
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id = client, organization_id
        self.can_manage = can_manage
        self.rows: list[Any] = []
        self.record: Any = None
        self.busy = False
        self.conflict = False
        self.pending: tuple[Any, dict[str, object]] | None = None
        self._worker: _Work | None = None
        self._callback: Callable[[Any], None] | None = None
        self._selected = -1
        self._previewing = False
        self._baseline = ("", "", "")
        self.setWindowTitle("동의서·서식 관리")
        self.setModal(True)
        self.resize(980, 700)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        heading = QLabel("동의서·서식 관리")
        heading.setObjectName("page-title")
        layout.addWidget(heading)
        layout.addWidget(
            QLabel(
                "초안을 검토한 뒤 게시하세요. 게시한 내용은 보존되며 수정은 새 버전에서 진행합니다."
            )
        )
        toolbar = QHBoxLayout()
        self.new_button = QPushButton("새 서식")
        self.reload_button = QPushButton("새로고침")
        toolbar.addWidget(self.new_button)
        toolbar.addStretch()
        toolbar.addWidget(self.reload_button)
        layout.addLayout(toolbar)
        splitter = QSplitter()
        self.list = QListWidget()
        splitter.addWidget(self.list)
        editor = QWidget()
        right = QVBoxLayout(editor)
        self.info = QLabel("새 초안")
        self.info.setTextFormat(Qt.TextFormat.PlainText)
        right.addWidget(self.info)
        self.history = QComboBox()
        self.history.addItem("현재 버전", None)
        right.addWidget(self.history)
        form = QFormLayout()
        form.setSpacing(12)
        self.name = QLineEdit()
        self.name.setMaxLength(200)
        self.description = QTextEdit()
        self.description.setMaximumHeight(80)
        self.content = QTextEdit()
        self.content.setAcceptRichText(False)
        self.description.setAcceptRichText(False)
        form.addRow("서식 이름", self.name)
        form.addRow("설명", self.description)
        right.addLayout(form)
        right.addWidget(QLabel("본문"))
        variables = QHBoxLayout()
        self.field_combo = QComboBox()
        for key, label in (
            ("customer.name", "고객 이름"),
            ("customer.phone", "고객 연락처"),
            ("customer.birth_date", "고객 생년월일"),
            ("treatment.name", "시술명"),
            ("treatment.date", "시술일"),
            ("treatment.practitioner", "담당자"),
            ("treatment.amount", "예정 금액"),
            ("treatment.consultation_goal", "상담 목표"),
        ):
            self.field_combo.addItem(label, key)
        self.insert_field_button = QPushButton("자동 채움 항목 삽입")
        self.insert_field_button.clicked.connect(self._insert_field)
        variables.addWidget(self.field_combo)
        variables.addWidget(self.insert_field_button)
        right.addLayout(variables)
        help_text = QLabel(
            "삽입한 항목은 발행 시 자동 채워집니다. 해당 값이 미등록이면 발행이 중지됩니다."
        )
        help_text.setWordWrap(True)
        right.addWidget(help_text)
        right.addWidget(self.content, 1)
        actions = QHBoxLayout()
        self.buttons: dict[str, QPushButton] = {}
        for action, label in [
            ("save", "초안 저장"),
            ("publish", "게시"),
            ("revise", "새 버전 만들기"),
            ("retire", "폐기"),
        ]:
            button = QPushButton(label)
            if action in {"save", "publish"}:
                button.setProperty("role", "primary")
            elif action == "retire":
                button.setProperty("role", "danger")
            button.clicked.connect(lambda _checked=False, action=action: self.mutate(action))
            actions.addWidget(button)
            self.buttons[action] = button
        right.addLayout(actions)
        splitter.addWidget(editor)
        splitter.setStretchFactor(1, 3)
        layout.addWidget(splitter, 1)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        footer = QHBoxLayout()
        self.retry = QPushButton("같은 요청 재시도")
        self.retry.hide()
        self.retry.clicked.connect(self._retry)
        footer.addWidget(self.retry)
        footer.addStretch()
        close = QPushButton("닫기")
        close.clicked.connect(self.reject)
        footer.addWidget(close)
        layout.addLayout(footer)
        self.new_button.clicked.connect(self.new)
        self.reload_button.clicked.connect(self.reload)
        self.list.currentRowChanged.connect(self.select)
        self.history.currentIndexChanged.connect(self._preview)
        self.reload()

    def fields(self) -> tuple[str, str, str]:
        return self.name.text(), self.description.toPlainText(), self.content.toPlainText()

    def _insert_field(self) -> None:
        if self.content.isReadOnly():
            return
        self.content.insertPlainText("{{" + str(self.field_combo.currentData()) + "}}")
        self.content.setFocus()

    def dirty(self) -> bool:
        return self.history.currentIndex() == 0 and self.fields() != self._baseline

    def confirm_leave(self) -> bool:
        if self.busy:
            self.status.setText("요청 처리 중입니다. 완료 후 닫아주세요.")
            return False
        if not self.dirty() and self.pending is None:
            return True
        warning = "저장하지 않은 입력을 버리시겠습니까?"
        if self.pending:
            warning += (
                "\n서버 처리 여부가 확인되지 않았습니다. "
                "재시도하면 중복 없이 결과를 확인할 수 있습니다."
            )
        return (
            QMessageBox.question(
                self,
                "작성 중인 서식",
                warning,
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
            # Complete QDialog's lifecycle so the parent receives finished once.
            super().reject()
            event.accept()
        else:
            event.ignore()

    def _controls(self) -> None:
        unlocked = not self.busy and self.pending is None
        editable = (
            unlocked and self.can_manage and not self.conflict and self.history.currentIndex() == 0
        )
        state = self.record.status if self.record else "draft"
        self.name.setReadOnly(not (editable and state == "draft"))
        self.description.setReadOnly(not (editable and state == "draft"))
        self.content.setReadOnly(not (editable and state == "draft"))
        self.field_combo.setEnabled(editable and state == "draft")
        self.insert_field_button.setEnabled(editable and state == "draft")
        for action, button in self.buttons.items():
            allowed = state == "draft" if action in {"save", "publish"} else state == "published"
            if action == "retire":
                allowed = state != "retired"
            button.setEnabled(
                editable and allowed and (action == "save" or self.record is not None)
            )
        self.new_button.setEnabled(unlocked and self.can_manage)
        self.reload_button.setEnabled(unlocked)
        self.list.setEnabled(unlocked)
        self.history.setEnabled(unlocked)
        self.retry.setVisible(self.pending is not None and not self.busy)

    def _run(self, operation: Callable[[], Any], callback: Callable[[Any], None]) -> None:
        self.busy = True
        self._callback = callback
        self._controls()
        self._worker = _Work(operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        result, error = outcome
        self.busy = False
        if error is not None:
            code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            if isinstance(error, PermissionError):
                code = 403
            if code in {400, 401, 403, 404, 409, 422}:
                self.pending = None
            self.conflict = code == 409
            self.status.setText(
                {
                    401: "로그인이 만료되었습니다. 입력은 유지됩니다.",
                    403: "서식 관리 권한이 없습니다. 입력은 유지됩니다.",
                    409: "다른 변경이 있습니다. 필요한 입력을 복사한 뒤 새로고침하세요.",
                    422: "서식 이름과 본문을 확인하세요. 빈 본문은 게시할 수 없습니다.",
                }.get(code, "요청을 완료하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.")
            )
        else:
            callback = self._callback
            if callback:
                callback(result)
        self._controls()

    def reload(self) -> None:
        if not self.confirm_leave():
            return
        self.pending = None
        self.status.setText("서식을 불러오는 중...")
        self._run(lambda: self.client.list_document_templates(self.organization_id), self._loaded)

    def _loaded(self, rows: Any) -> None:
        self.rows = list(rows)
        self.record = None
        self._selected = -1
        self.list.blockSignals(True)
        self.list.clear()
        for row in self.rows:
            self.list.addItem(f"{row.name} · v{row.version} · {STATUS.get(row.status, row.status)}")
        self.list.blockSignals(False)
        self._populate(None)
        self.status.setText(f"서식 {len(self.rows)}개 · 항목을 선택하거나 새 서식을 작성하세요.")

    def _populate(self, row: Any) -> None:
        self.record = row
        self.conflict = False
        self.pending = None
        self._previewing = False
        self.history.blockSignals(True)
        self.history.clear()
        self.history.addItem("현재 버전", None)
        self.history.blockSignals(False)
        self.name.setText(row.name if row else "")
        self.description.setPlainText(row.description if row else "")
        self.content.setPlainText(row.content if row else "")
        self._baseline = self.fields()
        self.info.setText(
            f"v{row.version} · {STATUS.get(row.status, row.status)}" if row else "새 초안"
        )
        self._controls()

    def new(self) -> None:
        if not self.can_manage or not self.confirm_leave():
            return
        self.list.blockSignals(True)
        self.list.setCurrentRow(-1)
        self.list.blockSignals(False)
        self._selected = -1
        self._populate(None)

    def select(self, index: int) -> None:
        if not 0 <= index < len(self.rows):
            return
        if not self.confirm_leave():
            self.list.blockSignals(True)
            self.list.setCurrentRow(self._selected)
            self.list.blockSignals(False)
            return
        self._selected = index
        self._populate(self.rows[index])
        self._load_history()

    def _load_history(self) -> None:
        if self.record:
            template_id = self.record.id
            self._run(
                lambda: self.client.list_document_template_versions(
                    self.organization_id, template_id
                ),
                self._history_loaded,
            )

    def _history_loaded(self, versions: Any) -> None:
        for version in versions:
            self.history.addItem(
                f"게시본 v{version['version']} · {version['published_at']}", version
            )
        self.status.setText(
            "게시본은 읽기 전용입니다. 새 버전을 만들면 이전 게시 내용은 그대로 보존됩니다."
        )

    def _preview(self, index: int) -> None:
        if not self._previewing and self.fields() != self._baseline and index != 0:
            self.history.blockSignals(True)
            self.history.setCurrentIndex(0)
            self.history.blockSignals(False)
            self.status.setText("작성 중인 초안을 저장한 뒤 게시본을 조회하세요.")
            return
        version = self.history.currentData()
        self._previewing = bool(version)
        if version:
            self.name.setText(version["name"])
            self.description.setPlainText(version["description"])
            self.content.setPlainText(version["content"])
            self.info.setText(f"게시본 v{version['version']} · 게시자 {version['published_by']}")
        elif self.record:
            self.name.setText(self.record.name)
            self.description.setPlainText(self.record.description)
            self.content.setPlainText(self.record.content)
            self.info.setText(
                f"v{self.record.version} · {STATUS.get(self.record.status, self.record.status)}"
            )
        self._controls()

    def mutate(self, action: str) -> None:
        if (
            self.busy
            or self.pending
            or not self.can_manage
            or self.conflict
            or self.history.currentIndex() != 0
        ):
            return
        if self.record is None and action != "save":
            return
        if action != "save" and self.dirty():
            self.status.setText("변경한 초안을 먼저 저장하세요.")
            return
        if action in {"publish", "retire"}:
            text = (
                "현재 내용을 게시하시겠습니까? 게시본은 수정할 수 없습니다."
                if action == "publish"
                else "서식을 폐기하시겠습니까? 이전 게시본은 보존되며 되돌릴 수 없습니다."
            )
            if (
                QMessageBox.question(
                    self,
                    "서식 상태 변경",
                    text,
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                    QMessageBox.StandardButton.No,
                )
                != QMessageBox.StandardButton.Yes
            ):
                return
        name, description, content = self.fields()
        if action == "save" and (
            not name.strip() or len(description) > 100_000 or len(content) > 100_000
        ):
            self.status.setText("이름은 필수이며 설명과 본문은 각각 100,000자 이하여야 합니다.")
            return
        payload: dict[str, object] = {
            "action": "create" if self.record is None else action,
            "expected_revision": self.record.revision if self.record else 0,
            "operation_id": str(uuid4()),
        }
        if action == "save":
            payload["values"] = {"name": name, "description": description, "content": content}
        self.pending = (self.record.id if self.record else uuid4(), payload)
        self._retry()

    def _retry(self) -> None:
        if self.busy or self.pending is None:
            return
        template_id, payload = self.pending
        self.status.setText("서식을 저장하는 중...")
        self._run(
            lambda: self.client.mutate_document_template(
                self.organization_id, template_id, payload
            ),
            self._saved,
        )

    def _saved(self, row: Any) -> None:
        self.pending = None
        index = next((i for i, old in enumerate(self.rows) if old.id == row.id), -1)
        if index < 0:
            self.rows.append(row)
        else:
            self.rows[index] = row
        rows = self.rows
        self._loaded(rows)
        index = next(i for i, old in enumerate(self.rows) if old.id == row.id)
        self.list.setCurrentRow(index)
        self.changed.emit()
