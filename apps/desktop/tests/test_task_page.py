from dataclasses import replace
from uuid import UUID

from business_assistant_desktop.task_page import Task, TaskPage
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMessageBox

ORG = UUID("11111111-1111-1111-1111-111111111111")
USER = UUID("22222222-2222-2222-2222-222222222222")


class FakeTaskClient:
    def __init__(self) -> None:
        self.tasks = [
            Task(
                UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                ORG,
                USER,
                "Write brief",
                "",
                None,
                "open",
                "normal",
            ),
            Task(
                UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
                ORG,
                USER,
                "Ship release",
                "",
                None,
                "done",
                "high",
            ),
        ]

    def list_tasks(self, organization_id: UUID, status: str | None = None) -> list[Task]:
        return [
            task
            for task in self.tasks
            if task.organization_id == organization_id and (status is None or task.status == status)
        ]

    def create_task(
        self,
        organization_id: UUID,
        title: str,
        description: str,
        due_at: str | None,
        status: str,
        priority: str,
    ) -> Task:
        task = Task(
            UUID("cccccccc-cccc-cccc-cccc-cccccccccccc"),
            organization_id,
            USER,
            title,
            description,
            due_at,
            status,
            priority,
        )
        self.tasks.append(task)
        return task

    def update_task(
        self, organization_id: UUID, task_id: UUID, values: dict[str, str | None]
    ) -> Task:
        index = next(i for i, task in enumerate(self.tasks) if task.id == task_id)
        updated = replace(self.tasks[index], **values)
        self.tasks[index] = updated
        return updated

    def delete_task(self, organization_id: UUID, task_id: UUID) -> None:
        self.tasks = [task for task in self.tasks if task.id != task_id]


def test_task_page_lists_and_filters_tasks(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeTaskClient()
    page = TaskPage(client, ORG)
    qtbot.addWidget(page)

    assert page.task_table.rowCount() == 2
    page.status_filter.setCurrentText("완료")
    assert page.task_table.rowCount() == 1
    assert page.task_table.item(0, 0).text() == "Ship release"


def test_task_page_creates_updates_and_deletes_task(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeTaskClient()
    page = TaskPage(client, ORG)
    qtbot.addWidget(page)
    page.title_input.setText("New task")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert page.task_table.rowCount() == 3
    assert page.task_table.item(2, 0).text() == "New task"

    page.task_table.selectRow(2)
    page.title_input.setText("Renamed task")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert page.task_table.item(2, 0).text() == "Renamed task"
    page.task_table.selectRow(2)
    qtbot.mouseClick(page.delete_button, Qt.MouseButton.LeftButton)
    assert page.task_table.rowCount() == 2


def test_task_page_requires_title(qtbot) -> None:  # type: ignore[no-untyped-def]
    page = TaskPage(FakeTaskClient(), ORG)
    qtbot.addWidget(page)
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert "제목" in page.error_label.text()


def test_task_page_uses_shared_error_surface(qtbot) -> None:  # type: ignore[no-untyped-def]
    page = TaskPage(FakeTaskClient(), ORG)
    qtbot.addWidget(page)
    assert page.error_label.objectName() == "error"


def test_filter_change_cancel_preserves_unsaved_draft(qtbot, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    page = TaskPage(FakeTaskClient(), ORG)
    qtbot.addWidget(page)
    page.title_input.setText("작성 중인 업무")
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args, **kwargs: QMessageBox.StandardButton.Cancel,
    )

    page.status_filter.setCurrentText("완료")

    assert page.status_filter.currentText() == "전체"
    assert page.task_table.rowCount() == 2
    assert page.title_input.text() == "작성 중인 업무"


def test_selection_change_cancel_preserves_current_draft(qtbot, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    page = TaskPage(FakeTaskClient(), ORG)
    qtbot.addWidget(page)
    page.task_table.selectRow(0)
    page.title_input.setText("저장 전 수정")
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args, **kwargs: QMessageBox.StandardButton.Cancel,
    )

    page.task_table.selectRow(1)

    assert page.task_table.currentRow() == 0
    assert page.title_input.text() == "저장 전 수정"


def test_save_failure_preserves_draft(qtbot) -> None:  # type: ignore[no-untyped-def]
    class FailingTaskClient(FakeTaskClient):
        def create_task(self, *args, **kwargs) -> Task:  # type: ignore[no-untyped-def]
            raise RuntimeError("offline")

    page = TaskPage(FailingTaskClient(), ORG)
    qtbot.addWidget(page)
    page.title_input.setText("사라지면 안 되는 업무")
    page.description_input.setPlainText("작성 중인 상세 내용")

    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)

    assert page.title_input.text() == "사라지면 안 되는 업무"
    assert page.description_input.toPlainText() == "작성 중인 상세 내용"
    assert "실패" in page.error_label.text()
