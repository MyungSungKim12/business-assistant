"""Asynchronous, customer-scoped activity history and compact composer."""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

if TYPE_CHECKING:
    from business_assistant_desktop.api_client import CustomerActivity


class ActivityClient(Protocol):
    def list_customer_activities(
        self, organization_id: UUID, customer_id: UUID
    ) -> list["CustomerActivity"]: ...

    def create_customer_activity(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> "CustomerActivity": ...


class _Signals(QObject):
    finished = Signal(object)


class _Request(QRunnable):
    def __init__(self, generation: int, kind: str, operation: Callable[[], object]):
        super().__init__()
        self.generation, self.kind, self.operation = generation, kind, operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((self, result, error))


class CustomerActivityPanel(QWidget):
    saved = Signal()
    dirty_changed = Signal()

    def __init__(self, client: ActivityClient, organization_id: UUID, can_manage: bool = True):
        super().__init__()
        self._client, self._organization_id = client, organization_id
        self._can_manage = can_manage
        self._customer_id: UUID | None = None
        self._generation = 0
        self._workers: set[_Request] = set()
        self._activities: list[Any] = []
        self.is_saving = False
        self.is_loading = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(4)
        toolbar = QHBoxLayout()
        self.add_button = QPushButton("활동 추가")
        self.retry_button = QPushButton("다시 불러오기")
        toolbar.addWidget(self.add_button)
        toolbar.addStretch()
        toolbar.addWidget(self.retry_button)
        layout.addLayout(toolbar)
        self.status_label = QLabel("고객을 선택하세요.")
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)
        self.history_label = QLabel()
        self.history_label.setObjectName("history-content")
        self.history_label.setTextFormat(Qt.TextFormat.PlainText)
        self.history_label.setWordWrap(True)
        self.history_label.setAlignment(Qt.AlignmentFlag.AlignTop)
        self.history_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.history_scroll = QScrollArea()
        self.history_scroll.setWidgetResizable(True)
        self.history_scroll.setMinimumHeight(36)
        self.history_scroll.setWidget(self.history_label)
        layout.addWidget(self.history_scroll, 1)
        self.composer = QWidget()
        form = QVBoxLayout(self.composer)
        form.setContentsMargins(0, 0, 0, 0)
        form.setSpacing(3)
        heading = QHBoxLayout()
        self.type_combo = QComboBox()
        self.type_combo.addItem("상담 메모", "note")
        self.type_combo.addItem("시술 메모", "treatment")
        self.title_input = QLineEdit()
        self.title_input.setPlaceholderText("제목 (필수, 100자 이내)")
        self.title_input.setAccessibleName("활동 제목")
        self.title_input.setMinimumWidth(50)
        heading.addWidget(self.type_combo)
        heading.addWidget(self.title_input, 1)
        form.addLayout(heading)
        self.description_input = QTextEdit()
        self.description_input.setPlaceholderText("활동 내용 (10,000자 이내)")
        self.description_input.setAccessibleName("활동 내용")
        self.description_input.setFixedHeight(48)
        form.addWidget(self.description_input)
        self.save_button = QPushButton("활동 저장")
        form.addWidget(self.save_button)
        layout.addWidget(self.composer)
        self.composer.hide()
        self.retry_button.hide()
        self.add_button.clicked.connect(self._toggle_composer)
        self.save_button.clicked.connect(self._save)
        self.retry_button.clicked.connect(self._load)
        self.title_input.textChanged.connect(lambda *_: self.dirty_changed.emit())
        self.description_input.textChanged.connect(lambda *_: self.dirty_changed.emit())
        self.type_combo.currentIndexChanged.connect(lambda *_: self.dirty_changed.emit())
        self._update_controls()

    def has_unsaved_changes(self) -> bool:
        return bool(
            self.title_input.text()
            or self.description_input.toPlainText()
            or self.type_combo.currentIndex() != 0
        )

    def discard_draft(self) -> None:
        if self.is_saving:
            return
        self.title_input.clear()
        self.description_input.clear()
        self.type_combo.setCurrentIndex(0)
        self.composer.hide()
        self.history_scroll.show()
        self.add_button.setText("활동 추가")
        self.dirty_changed.emit()

    def set_customer(self, customer_id: UUID | None) -> None:
        if self.is_saving or customer_id == self._customer_id:
            return
        self._customer_id = customer_id
        self.discard_draft()
        self._activities = []
        self.history_label.clear()
        self._load()

    def _toggle_composer(self) -> None:
        if not self._can_manage or self._customer_id is None or self.is_saving:
            return
        expanded = self.composer.isHidden()
        self.composer.setVisible(expanded)
        self.history_scroll.setVisible(not expanded)
        self.add_button.setText("기록 보기" if expanded else "활동 추가")

    def _update_controls(self) -> None:
        editable = (
            self._can_manage
            and self._customer_id is not None
            and not self.is_saving
            and not self.is_loading
        )
        self.add_button.setEnabled(editable)
        self.save_button.setEnabled(editable)
        self.title_input.setEnabled(editable)
        self.description_input.setEnabled(editable)
        self.type_combo.setEnabled(editable)
        self.retry_button.setEnabled(self._customer_id is not None and not self.is_saving)

    def _start(self, kind: str, operation: Callable[[], object]) -> None:
        worker = _Request(self._generation, kind, operation)
        self._workers.add(worker)
        worker.signals.finished.connect(self._finished, Qt.ConnectionType.QueuedConnection)
        QThreadPool.globalInstance().start(worker)

    def _load(self) -> None:
        if self.is_saving:
            return
        self._generation += 1
        self.is_loading = self._customer_id is not None
        self.retry_button.hide()
        self._update_controls()
        customer_id = self._customer_id
        if customer_id is None:
            self.status_label.setText("고객을 선택하세요.")
            return
        self.status_label.setText("활동을 불러오는 중…")
        self._start(
            "load",
            lambda: self._client.list_customer_activities(self._organization_id, customer_id),
        )

    def _save(self) -> None:
        customer_id = self._customer_id
        if not self._can_manage or customer_id is None or self.is_saving or self.is_loading:
            return
        title = self.title_input.text().strip()
        description = self.description_input.toPlainText()
        if not 1 <= len(title) <= 100 or len(description) > 10000:
            self.status_label.setText("제목은 1~100자, 내용은 10,000자 이내로 입력하세요.")
            return
        values: dict[str, object] = {
            "activity_type": self.type_combo.currentData(),
            "title": title,
            "description": description,
        }
        self._generation += 1  # An earlier load must not overwrite this save.
        self.is_saving = True
        self._update_controls()
        self.status_label.setText("활동을 저장하는 중…")
        self._start(
            "save",
            lambda: self._client.create_customer_activity(
                self._organization_id, customer_id, values
            ),
        )

    @Slot(object)
    def _finished(self, outcome: tuple[_Request, Any, Exception | None]) -> None:
        worker, result, error = outcome
        self._workers.discard(worker)
        if worker.generation != self._generation:
            return
        if worker.kind == "save":
            self.is_saving = False
        if worker.kind == "load":
            self.is_loading = False
        self._update_controls()
        if error is not None:
            self.status_label.setText(
                "활동 저장에 실패했습니다. 입력 내용을 확인하고 다시 저장하세요."
                if worker.kind == "save"
                else "활동을 불러오지 못했습니다. 다시 시도하세요."
            )
            self.retry_button.setVisible(worker.kind == "load")
            return
        if worker.kind == "save":
            self._activities = [result, *[a for a in self._activities if a.id != result.id]]
            self.discard_draft()
        else:
            self._activities = result
        self._activities.sort(key=lambda activity: _timestamp(activity.occurred_at), reverse=True)
        self.history_label.setText(
            "\n\n".join(
                f"● {_display_time(activity.occurred_at)}\n"
                f"{'시술 메모' if activity.activity_type == 'treatment' else '상담 메모'} · "
                f"{activity.title}\n{activity.description}"
                for activity in self._activities
            )
        )
        self.status_label.setText(
            f"활동 {len(self._activities)}건" if self._activities else "등록된 활동이 없습니다."
        )
        self.retry_button.hide()
        if worker.kind == "save":
            self.saved.emit()


def _timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    except ValueError:
        return datetime(1970, 1, 1, tzinfo=UTC)


def _display_time(value: str) -> str:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "날짜 확인 필요"
    return _timestamp(value).astimezone().strftime("%Y-%m-%d %H:%M")
