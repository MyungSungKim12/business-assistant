"""Organization file list, upload, download, and archive page."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True, slots=True)
class FileAsset:
    id: UUID
    original_name: str
    content_type: str
    size_bytes: int


class FileClient(Protocol):
    """Operations the file page needs from its API boundary."""

    def list_files(self, organization_id: UUID) -> list[FileAsset]: ...

    def upload_file(self, organization_id: UUID, path: Path) -> FileAsset: ...

    def get_download_url(self, organization_id: UUID, file_id: UUID) -> str: ...

    def archive_file(self, organization_id: UUID, file_id: UUID) -> None: ...


class FilePage(QWidget):
    """Manage file metadata through a small dependency-injected client."""

    def __init__(
        self,
        client: FileClient,
        organization_id: UUID,
        *,
        can_manage: bool = True,
        open_url: Callable[[str], bool] | None = None,
    ) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id
        self._files: list[FileAsset] = []
        self._selected_path: Path | None = None
        self._open_url = open_url or _open_url

        heading = QLabel("파일·자료")
        heading.setObjectName("page-title")
        refresh_button = QPushButton("새로고침")
        refresh_button.clicked.connect(self.refresh)
        toolbar = QHBoxLayout()
        toolbar.addWidget(heading)
        toolbar.addStretch()
        toolbar.addWidget(refresh_button)

        self.file_list = QListWidget()
        self.selected_file_label = QLabel("선택된 파일 없음")
        self.select_button = QPushButton("파일 선택")
        self.upload_button = QPushButton("업로드")
        self.download_button = QPushButton("다운로드")
        self.archive_button = QPushButton("보관")
        self.archive_button.setEnabled(can_manage)
        self.select_button.clicked.connect(self._choose_file)
        self.upload_button.clicked.connect(self._upload)
        self.download_button.clicked.connect(self._download)
        self.archive_button.clicked.connect(self._archive)
        actions = QHBoxLayout()
        actions.addWidget(self.select_button)
        actions.addWidget(self.selected_file_label)
        actions.addWidget(self.upload_button)
        actions.addStretch()
        actions.addWidget(self.download_button)
        actions.addWidget(self.archive_button)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addLayout(toolbar)
        layout.addWidget(self.file_list)
        layout.addLayout(actions)
        layout.addWidget(self.status_label)
        self.refresh()

    def refresh(self) -> None:
        self.status_label.setText("파일을 불러오는 중...")
        try:
            self._files = list(self._client.list_files(self._organization_id))
        except PermissionError:
            self._files = []
            self._render()
            self.status_label.setText("파일 접근 권한이 없습니다.")
            return
        except Exception:
            self._files = []
            self._render()
            self.status_label.setText("파일을 불러오지 못했습니다.")
            return
        self._render()
        count = len(self._files)
        self.status_label.setText(
            f"파일 {count}개를 불러왔습니다." if count else "등록된 파일이 없습니다."
        )

    def set_selected_file(self, path: Path) -> None:
        """Set an upload candidate selected by the user or a host file picker."""
        self._selected_path = path
        self.selected_file_label.setText(path.name)

    def _choose_file(self) -> None:
        selected, _ = QFileDialog.getOpenFileName(self, "업로드할 파일 선택")
        if selected:
            self.set_selected_file(Path(selected))

    def _upload(self) -> None:
        if self._selected_path is None:
            self.status_label.setText("업로드할 파일을 선택하세요.")
            return
        try:
            asset = self._client.upload_file(self._organization_id, self._selected_path)
        except PermissionError:
            self.status_label.setText("파일 업로드 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("파일을 업로드하지 못했습니다.")
            return
        self._files.append(asset)
        self._selected_path = None
        self.selected_file_label.setText("선택된 파일 없음")
        self._render()
        self.status_label.setText("파일을 업로드했습니다.")

    def _download(self) -> None:
        asset = self._selected_asset()
        if asset is None:
            self.status_label.setText("다운로드할 파일을 선택하세요.")
            return
        try:
            url = self._client.get_download_url(self._organization_id, asset.id)
            opened = self._open_url(url)
        except PermissionError:
            self.status_label.setText("파일 다운로드 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("다운로드 링크를 열지 못했습니다.")
            return
        self.status_label.setText(
            "다운로드 링크를 열었습니다." if opened else "다운로드 링크를 열지 못했습니다."
        )

    def _archive(self) -> None:
        asset = self._selected_asset()
        if asset is None:
            self.status_label.setText("보관할 파일을 선택하세요.")
            return
        try:
            self._client.archive_file(self._organization_id, asset.id)
        except PermissionError:
            self.status_label.setText("파일 보관 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("파일을 보관하지 못했습니다.")
            return
        self._files = [item for item in self._files if item.id != asset.id]
        self._render()
        self.status_label.setText("파일을 보관했습니다.")

    def _selected_asset(self) -> FileAsset | None:
        item = self.file_list.currentItem()
        if item is None:
            return None
        file_id = item.data(Qt.ItemDataRole.UserRole)
        return next((asset for asset in self._files if asset.id == file_id), None)

    def _render(self) -> None:
        self.file_list.clear()
        for asset in self._files:
            item = QListWidgetItem(f"{asset.original_name} · {_format_size(asset.size_bytes)}")
            item.setData(Qt.ItemDataRole.UserRole, asset.id)
            self.file_list.addItem(item)


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.1f} MB"


def _open_url(url: str) -> bool:
    return QDesktopServices.openUrl(QUrl(url))
