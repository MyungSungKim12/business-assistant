"""Task list and basic CRUD page for an organization."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True, slots=True)
class Task:
    id: UUID
    organization_id: UUID
    created_by: UUID
    title: str
    description: str
    due_at: str | None
    status: str
    priority: str


class TaskApi(Protocol):
    def list_tasks(self, organization_id: UUID, status: str | None = None) -> list[Task]: ...

    def create_task(
        self,
        organization_id: UUID,
        title: str,
        description: str,
        due_at: str | None,
        status: str,
        priority: str,
    ) -> Task: ...

    def update_task(
        self, organization_id: UUID, task_id: UUID, values: dict[str, str | None]
    ) -> Task: ...

    def delete_task(self, organization_id: UUID, task_id: UUID) -> None: ...


_STATUSES = [
    ("전체", None),
    ("열림", "open"),
    ("진행 중", "in_progress"),
    ("완료", "done"),
    ("취소", "canceled"),
]
_PRIORITIES = [("낮음", "low"), ("보통", "normal"), ("높음", "high")]


class TaskPage(QWidget):
    """Display and edit tasks through a small dependency-injected API boundary."""

    def __init__(self, client: TaskApi, organization_id: UUID) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id
        self._tasks: list[Task] = []

        heading = QLabel("업무")
        heading.setObjectName("page-title")
        self.status_filter = QComboBox()
        self.status_filter.addItems([label for label, _ in _STATUSES])
        self.status_filter.currentIndexChanged.connect(self.refresh)
        refresh_button = QPushButton("새로고침")
        refresh_button.clicked.connect(self.refresh)
        toolbar = QHBoxLayout()
        toolbar.addWidget(heading)
        toolbar.addStretch()
        toolbar.addWidget(QLabel("상태"))
        toolbar.addWidget(self.status_filter)
        toolbar.addWidget(refresh_button)

        self.task_table = QTableWidget(0, 4)
        self.task_table.setHorizontalHeaderLabels(["제목", "상태", "우선순위", "마감일"])
        self.task_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.task_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.task_table.itemSelectionChanged.connect(self._load_selected)

        self.title_input = QLineEdit()
        self.description_input = QTextEdit()
        self.description_input.setFixedHeight(70)
        self.due_input = QLineEdit()
        self.due_input.setPlaceholderText("예: 2030-01-01T09:00:00+09:00")
        self.status_input = QComboBox()
        self.status_input.addItems([label for label, _ in _STATUSES[1:]])
        self.priority_input = QComboBox()
        self.priority_input.addItems([label for label, _ in _PRIORITIES])
        form = QFormLayout()
        form.addRow("제목", self.title_input)
        form.addRow("설명", self.description_input)
        form.addRow("마감일", self.due_input)
        form.addRow("상태", self.status_input)
        form.addRow("우선순위", self.priority_input)
        self.save_button = QPushButton("업무 저장")
        self.delete_button = QPushButton("선택 업무 삭제")
        self.save_button.clicked.connect(self._save)
        self.delete_button.clicked.connect(self._delete)
        actions = QHBoxLayout()
        actions.addWidget(self.save_button)
        actions.addWidget(self.delete_button)
        self.error_label = QLabel()
        self.error_label.setWordWrap(True)
        self.error_label.setStyleSheet("color: #b91c1c")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addLayout(toolbar)
        layout.addWidget(self.task_table)
        layout.addLayout(form)
        layout.addLayout(actions)
        layout.addWidget(self.error_label)
        self.refresh()

    def refresh(self) -> None:
        status = _STATUSES[self.status_filter.currentIndex()][1]
        try:
            self._tasks = self._client.list_tasks(self._organization_id, status)
        except Exception:
            self._tasks = []
            self.error_label.setText("업무를 불러오지 못했습니다.")
            return
        self.error_label.clear()
        self.task_table.setRowCount(0)
        for task in self._tasks:
            row = self.task_table.rowCount()
            self.task_table.insertRow(row)
            values = [
                task.title,
                _status_label(task.status),
                _priority_label(task.priority),
                task.due_at or "-",
            ]
            for column, value in enumerate(values):
                self.task_table.setItem(row, column, QTableWidgetItem(value))

    def _load_selected(self) -> None:
        row = self.task_table.currentRow()
        if row < 0 or row >= len(self._tasks):
            return
        task = self._tasks[row]
        self.title_input.setText(task.title)
        self.description_input.setPlainText(task.description)
        self.due_input.setText(task.due_at or "")
        self.status_input.setCurrentIndex(_value_index(_STATUSES[1:], task.status))
        self.priority_input.setCurrentIndex(_value_index(_PRIORITIES, task.priority))

    def _save(self) -> None:
        title = self.title_input.text().strip()
        if not title:
            self.error_label.setText("업무 제목을 입력하세요.")
            return
        values = {
            "title": title,
            "description": self.description_input.toPlainText(),
            "due_at": self.due_input.text().strip() or None,
            "status": _STATUSES[self.status_input.currentIndex() + 1][1],
            "priority": _PRIORITIES[self.priority_input.currentIndex()][1],
        }
        row = self.task_table.currentRow()
        try:
            if 0 <= row < len(self._tasks):
                self._client.update_task(self._organization_id, self._tasks[row].id, values)
            else:
                self._client.create_task(
                    self._organization_id,
                    title=title,
                    description=values["description"] or "",
                    due_at=values["due_at"],
                    status=values["status"] or "open",
                    priority=values["priority"] or "normal",
                )
        except Exception:
            self.error_label.setText("업무 저장에 실패했습니다.")
            return
        self.refresh()

    def _delete(self) -> None:
        row = self.task_table.currentRow()
        if row < 0 or row >= len(self._tasks):
            self.error_label.setText("삭제할 업무를 선택하세요.")
            return
        try:
            self._client.delete_task(self._organization_id, self._tasks[row].id)
        except Exception:
            self.error_label.setText("업무 삭제에 실패했습니다.")
            return
        self.refresh()


def _value_index(options: Sequence[tuple[str, str | None]], value: str) -> int:
    return next((index for index, (_, option) in enumerate(options) if option == value), 0)


def _status_label(value: str) -> str:
    return next((label for label, option in _STATUSES if option == value), value)


def _priority_label(value: str) -> str:
    return next((label for label, option in _PRIORITIES if option == value), value)
