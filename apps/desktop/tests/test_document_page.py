from uuid import UUID

from business_assistant_desktop.document_page import (
    Document,
    DocumentPage,
    DocumentTemplate,
)
from PySide6.QtCore import Qt

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
TEMPLATE_ID = UUID("22222222-2222-2222-2222-222222222222")
DOCUMENT_ID = UUID("33333333-3333-3333-3333-333333333333")
CREATED_DOCUMENT_ID = UUID("44444444-4444-4444-4444-444444444444")


class FakeDocumentClient:
    def __init__(self) -> None:
        self.templates = [DocumentTemplate(TEMPLATE_ID, "견적서", "기본 견적 내용")]
        self.documents = [Document(DOCUMENT_ID, "9월 견적", "draft", "본문", TEMPLATE_ID)]
        self.created: list[tuple[UUID, str, str, UUID | None]] = []

    def list_document_templates(self, organization_id: UUID) -> list[DocumentTemplate]:
        return self.templates

    def list_documents(self, organization_id: UUID) -> list[Document]:
        return self.documents

    def create_document(
        self, organization_id: UUID, title: str, content: str, template_id: UUID | None
    ) -> Document:
        self.created.append((organization_id, title, content, template_id))
        document = Document(CREATED_DOCUMENT_ID, title, "draft", content, template_id)
        self.documents.append(document)
        return document


def test_document_page_loads_templates_and_documents(qtbot) -> None:  # type: ignore[no-untyped-def]
    page = DocumentPage(FakeDocumentClient(), ORGANIZATION_ID)
    qtbot.addWidget(page)

    page.refresh()

    assert page.template_list.count() == 1
    assert page.template_list.item(0).text() == "견적서"
    assert page.document_list.count() == 1
    assert "9월 견적" in page.document_list.item(0).text()
    assert page.status_label.text() == "문서 1개를 불러왔습니다."


def test_document_page_creates_draft_from_selected_template(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeDocumentClient()
    page = DocumentPage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.refresh()
    page.title_input.setText("10월 견적")
    page.content_input.setPlainText("새 본문")
    page.template_combo.setCurrentIndex(1)

    qtbot.mouseClick(page.create_button, Qt.MouseButton.LeftButton)

    assert client.created == [(ORGANIZATION_ID, "10월 견적", "새 본문", TEMPLATE_ID)]
    assert page.document_list.count() == 2
    assert page.status_label.text() == "문서를 작성했습니다."


def test_document_page_reports_empty_error_and_read_only_states(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeDocumentClient()
    client.templates = []
    client.documents = []
    page = DocumentPage(client, ORGANIZATION_ID, can_manage=False)
    qtbot.addWidget(page)

    page.refresh()

    assert page.status_label.text() == "등록된 문서가 없습니다."
    assert not page.create_button.isEnabled()

    class FailingClient(FakeDocumentClient):
        def list_document_templates(self, organization_id: UUID) -> list[DocumentTemplate]:
            raise RuntimeError("offline")

    failing_page = DocumentPage(FailingClient(), ORGANIZATION_ID)
    qtbot.addWidget(failing_page)
    failing_page.refresh()
    assert failing_page.status_label.text() == "문서를 불러오지 못했습니다."

    class ForbiddenClient(FakeDocumentClient):
        def list_document_templates(self, organization_id: UUID) -> list[DocumentTemplate]:
            raise PermissionError

    forbidden_page = DocumentPage(ForbiddenClient(), ORGANIZATION_ID)
    qtbot.addWidget(forbidden_page)
    forbidden_page.refresh()
    assert forbidden_page.status_label.text() == "문서 접근 권한이 없습니다."
