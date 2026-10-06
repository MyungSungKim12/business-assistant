"""Template-backed document list and draft creation page."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
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

from business_assistant_desktop.template_manager import STATUS, TemplateManager
from business_assistant_desktop.ui_components import surface_panel


@dataclass(frozen=True, slots=True)
class DocumentTemplate:
    id: UUID
    name: str
    content: str
    description: str = ""
    status: str = "draft"
    version: int = 1
    revision: int = 1


@dataclass(frozen=True, slots=True)
class Document:
    id: UUID
    title: str
    status: str
    content: str
    template_id: UUID | None = None


class DocumentClient(Protocol):
    """Operations the document page needs from its API boundary."""

    def list_document_templates(self, organization_id: UUID) -> list[DocumentTemplate]: ...

    def list_documents(self, organization_id: UUID) -> list[Document]: ...

    def create_document(
        self, organization_id: UUID, title: str, content: str, template_id: UUID | None
    ) -> Document: ...


class DocumentPage(QWidget):
    """Show templates and documents, and create a new draft."""

    def __init__(
        self, client: DocumentClient, organization_id: UUID, *, can_manage: bool = True
    ) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id
        self._templates: list[DocumentTemplate] = []
        self._documents: list[Document] = []
        self._can_manage = can_manage
        self._manager: TemplateManager | None = None

        heading = QLabel("문서 자동화")
        heading.setObjectName("page-title")
        refresh_button = QPushButton("새로고침")
        refresh_button.clicked.connect(self.refresh)
        toolbar = QHBoxLayout()
        toolbar.addWidget(heading)
        toolbar.addStretch()
        self.manage_button = QPushButton("동의서·서식 관리")
        self.manage_button.clicked.connect(self._manage_templates)
        toolbar.addWidget(self.manage_button)
        toolbar.addWidget(refresh_button)

        self.template_list = QListWidget()
        self.document_list = QListWidget()
        lists = QHBoxLayout()
        template_column = QVBoxLayout()
        template_column.addWidget(QLabel("템플릿"))
        template_column.addWidget(self.template_list)
        document_column = QVBoxLayout()
        document_column.addWidget(QLabel("문서"))
        document_column.addWidget(self.document_list)
        lists.addLayout(template_column)
        lists.addLayout(document_column)

        self.title_input = QLineEdit()
        self.content_input = QTextEdit()
        self.content_input.setFixedHeight(100)
        self.template_combo = QComboBox()
        self.template_combo.addItem("템플릿 없음", None)
        self.template_combo.currentIndexChanged.connect(self._apply_template)
        form = QFormLayout()
        form.addRow("제목", self.title_input)
        form.addRow("템플릿", self.template_combo)
        form.addRow("본문", self.content_input)
        self.create_button = QPushButton("초안 작성")
        self.create_button.setProperty("role", "primary")
        self.create_button.setEnabled(can_manage)
        self.create_button.clicked.connect(self._create)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(18)
        layout.addLayout(toolbar)
        layout.addWidget(surface_panel("보관함", lists), 1)
        editor = QVBoxLayout()
        form.setSpacing(12)
        editor.addLayout(form)
        editor.addWidget(self.create_button)
        layout.addWidget(surface_panel("새 문서 작성", editor))
        layout.addWidget(self.status_label)
        self.refresh()

    def _manage_templates(self) -> None:
        self._manager = TemplateManager(
            self._client, self._organization_id, can_manage=self._can_manage, parent=self
        )
        self._manager.finished.connect(lambda _result: self.refresh())
        self._manager.show()

    def confirm_leave(self) -> bool:
        if self._manager and self._manager.isVisible() and not self._manager.confirm_leave():
            return False
        if not self.title_input.text() and not self.content_input.toPlainText():
            return True
        return (
            QMessageBox.question(
                self,
                "작성 중인 문서",
                "저장하지 않은 문서 입력을 버리시겠습니까?",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def refresh(self) -> None:
        self.status_label.setText("문서를 불러오는 중...")
        try:
            templates = list(self._client.list_document_templates(self._organization_id))
            documents = list(self._client.list_documents(self._organization_id))
        except PermissionError:
            self.status_label.setText("문서 접근 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("문서를 불러오지 못했습니다.")
            return
        self._templates, self._documents = templates, documents
        self._render()
        count = len(self._documents)
        self.status_label.setText(
            f"문서 {count}개를 불러왔습니다." if count else "등록된 문서가 없습니다."
        )

    def _render(self) -> None:
        self.template_list.clear()
        selected = self.template_combo.currentData()
        self.template_combo.blockSignals(True)
        self.template_combo.clear()
        self.template_combo.addItem("템플릿 없음", None)
        for template in self._templates:
            state = STATUS.get(template.status, template.status)
            self.template_list.addItem(f"{template.name} · v{template.version} · {state}")
            if template.status == "published":
                self.template_combo.addItem(template.name, template.id)
        restored = self.template_combo.findData(selected)
        self.template_combo.setCurrentIndex(max(0, restored))
        self.template_combo.blockSignals(False)
        self.document_list.clear()
        for document in self._documents:
            self.document_list.addItem(f"{document.title} · {_status_label(document.status)}")

    def _apply_template(self, index: int) -> None:
        if index <= 0:
            return
        template_id = self.template_combo.itemData(index)
        template = next((row for row in self._templates if row.id == template_id), None)
        if template is None:
            return
        if not self.content_input.toPlainText().strip():
            self.content_input.setPlainText(template.content)

    def _create(self) -> None:
        if not self._can_manage:
            self.status_label.setText("문서 작성 권한이 없습니다.")
            return
        title = self.title_input.text().strip()
        if not title:
            self.status_label.setText("문서 제목을 입력하세요.")
            return
        template_id = self.template_combo.currentData()
        try:
            document = self._client.create_document(
                self._organization_id,
                title,
                self.content_input.toPlainText(),
                template_id if isinstance(template_id, UUID) else None,
            )
        except PermissionError:
            self.status_label.setText("문서 작성 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("문서를 작성하지 못했습니다.")
            return
        self._documents.append(document)
        self._render()
        self.title_input.clear()
        self.content_input.clear()
        self.status_label.setText("문서를 작성했습니다.")


def _status_label(value: str) -> str:
    return {"draft": "초안", "final": "완료", "archived": "보관"}.get(value, value)
