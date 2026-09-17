from dataclasses import replace
from uuid import UUID

from business_assistant_desktop.task_page import Task, TaskPage
from PySide6.QtCore import Qt

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
