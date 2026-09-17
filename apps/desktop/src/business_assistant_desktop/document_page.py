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
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True, slots=True)
class DocumentTemplate:
    id: UUID
    name: str
    content: str
    description: str = ""


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

        heading = QLabel("문서 자동화")
        heading.setObjectName("page-title")
        refresh_button = QPushButton("새로고침")
        refresh_button.clicked.connect(self.refresh)
        toolbar = QHBoxLayout()
        toolbar.addWidget(heading)
        toolbar.addStretch()
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
        self.create_button.setEnabled(can_manage)
        self.create_button.clicked.connect(self._create)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addLayout(toolbar)
        layout.addLayout(lists)
        layout.addLayout(form)
        layout.addWidget(self.create_button)
        layout.addWidget(self.status_label)
        self.refresh()

    def refresh(self) -> None:
        self.status_label.setText("문서를 불러오는 중...")
        try:
            self._templates = list(self._client.list_document_templates(self._organization_id))
            self._documents = list(self._client.list_documents(self._organization_id))
        except PermissionError:
            self._templates = []
            self._documents = []
            self.status_label.setText("문서 접근 권한이 없습니다.")
            self._render()
            return
        except Exception:
            self._templates = []
            self._documents = []
            self.status_label.setText("문서를 불러오지 못했습니다.")
            self._render()
            return
        self._render()
        count = len(self._documents)
        self.status_label.setText(
            f"문서 {count}개를 불러왔습니다." if count else "등록된 문서가 없습니다."
        )

    def _render(self) -> None:
        self.template_list.clear()
        self.template_combo.blockSignals(True)
        self.template_combo.clear()
        self.template_combo.addItem("템플릿 없음", None)
        for template in self._templates:
            self.template_list.addItem(template.name)
            self.template_combo.addItem(template.name, template.id)
        self.template_combo.blockSignals(False)
        self.document_list.clear()
        for document in self._documents:
            self.document_list.addItem(f"{document.title} · {_status_label(document.status)}")

    def _apply_template(self, index: int) -> None:
        if index <= 0:
            return
        template = self._templates[index - 1]
        if not self.content_input.toPlainText().strip():
            self.content_input.setPlainText(template.content)

    def _create(self) -> None:
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
