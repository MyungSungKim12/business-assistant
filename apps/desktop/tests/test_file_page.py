from pathlib import Path
from uuid import UUID

from business_assistant_desktop.file_page import FileAsset, FilePage
from PySide6.QtCore import Qt

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
FILE_ID = UUID("22222222-2222-2222-2222-222222222222")
UPLOADED_FILE_ID = UUID("33333333-3333-3333-3333-333333333333")


class FakeFileClient:
    def __init__(self) -> None:
        self.files = [FileAsset(FILE_ID, "계약서.pdf", "application/pdf", 2048)]
        self.uploaded: list[tuple[UUID, Path]] = []
        self.archived: list[tuple[UUID, UUID]] = []

    def list_files(self, organization_id: UUID) -> list[FileAsset]:
        return self.files

    def upload_file(self, organization_id: UUID, path: Path) -> FileAsset:
        self.uploaded.append((organization_id, path))
        asset = FileAsset(UPLOADED_FILE_ID, path.name, "text/plain", path.stat().st_size)
        self.files.append(asset)
        return asset

    def get_download_url(self, organization_id: UUID, file_id: UUID) -> str:
        return f"https://files.example.test/{file_id}?signed=yes"

    def archive_file(self, organization_id: UUID, file_id: UUID) -> None:
        self.archived.append((organization_id, file_id))
        self.files = [item for item in self.files if item.id != file_id]


def test_file_page_lists_files_and_formats_size(qtbot) -> None:  # type: ignore[no-untyped-def]
    page = FilePage(FakeFileClient(), ORGANIZATION_ID)
    qtbot.addWidget(page)

    page.refresh()

    assert page.file_list.count() == 1
    assert page.file_list.item(0).text() == "계약서.pdf · 2.0 KB"
    assert page.status_label.text() == "파일 1개를 불러왔습니다."


def test_file_page_uploads_selected_file(tmp_path, qtbot) -> None:  # type: ignore[no-untyped-def]
    selected = tmp_path / "메모.txt"
    selected.write_text("hello", encoding="utf-8")
    client = FakeFileClient()
    page = FilePage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.set_selected_file(selected)

    qtbot.mouseClick(page.upload_button, Qt.MouseButton.LeftButton)

    assert client.uploaded == [(ORGANIZATION_ID, selected)]
    assert page.file_list.count() == 2
    assert page.status_label.text() == "파일을 업로드했습니다."


def test_file_page_opens_signed_download_url_and_archives_for_manager(qtbot) -> None:  # type: ignore[no-untyped-def]
    opened: list[str] = []
    client = FakeFileClient()
    page = FilePage(client, ORGANIZATION_ID, open_url=lambda url: opened.append(url) or True)
    qtbot.addWidget(page)
    page.refresh()
    page.file_list.setCurrentRow(0)

    qtbot.mouseClick(page.download_button, Qt.MouseButton.LeftButton)
    qtbot.mouseClick(page.archive_button, Qt.MouseButton.LeftButton)

    assert opened == [f"https://files.example.test/{FILE_ID}?signed=yes"]
    assert client.archived == [(ORGANIZATION_ID, FILE_ID)]
    assert page.file_list.count() == 0


def test_file_page_reports_empty_error_and_read_only_states(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeFileClient()
    client.files = []
    page = FilePage(client, ORGANIZATION_ID, can_manage=False)
    qtbot.addWidget(page)
    page.refresh()
    assert page.status_label.text() == "등록된 파일이 없습니다."
    assert not page.archive_button.isEnabled()

    class FailingClient(FakeFileClient):
        def list_files(self, organization_id: UUID) -> list[FileAsset]:
            raise RuntimeError("offline")

    failing_page = FilePage(FailingClient(), ORGANIZATION_ID)
    qtbot.addWidget(failing_page)
    failing_page.refresh()
    assert failing_page.status_label.text() == "파일을 불러오지 못했습니다."

    class ForbiddenClient(FakeFileClient):
        def list_files(self, organization_id: UUID) -> list[FileAsset]:
            raise PermissionError

    forbidden_page = FilePage(ForbiddenClient(), ORGANIZATION_ID)
    qtbot.addWidget(forbidden_page)
    forbidden_page.refresh()
    assert forbidden_page.status_label.text() == "파일 접근 권한이 없습니다."
