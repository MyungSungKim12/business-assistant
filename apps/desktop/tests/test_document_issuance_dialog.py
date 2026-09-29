from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import httpx
from business_assistant_desktop.document_issuance_dialog import DocumentIssuanceDialog
from PySide6.QtWidgets import QMessageBox


class Client:
    def __init__(self):
        self.template = SimpleNamespace(
            id=uuid4(), name="관리 동의서", status="published", version=1
        )
        self.calls = []
        self.issue_error = None
        self.load_error = False
        self.preview = {
            "template_id": str(self.template.id),
            "template_version": 1,
            "title": "관리 동의서",
            "content": "<b>고객</b> · 수분 관리 · 0원",
            "source_snapshot": {"customer_name": "<b>고객</b>"},
            "missing_fields": [],
        }

    def list_document_templates(self, org):
        if self.load_error:
            raise RuntimeError("offline")
        return [self.template, SimpleNamespace(id=uuid4(), name="초안", status="draft", version=2)]

    def list_issued_treatment_documents(self, org, customer, treatment):
        return []

    def preview_treatment_document(self, org, customer, treatment, template):
        return deepcopy(self.preview)

    def issue_treatment_document(self, org, customer, treatment, payload):
        self.calls.append(deepcopy(payload))
        if self.issue_error:
            raise self.issue_error
        return {
            "id": str(uuid4()),
            "title": "관리 동의서",
            "content": self.preview["content"],
            "template_version": 1,
            "issued_at": "2026-09-22T10:00:00Z",
            "issued_by": str(uuid4()),
            "source_snapshot": self.preview["source_snapshot"],
        }


def setup(qtbot, *, can_manage=True, client=None):
    c = client or Client()
    w = DocumentIssuanceDialog(c, uuid4(), uuid4(), uuid4(), can_manage=can_manage)
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: not w.busy)
    return w, c


def preview(qtbot, w):
    w.template_combo.setCurrentIndex(1)
    w.load_preview()
    qtbot.waitUntil(lambda: not w.busy)


def test_preview_is_plain_text_and_requires_explicit_review(qtbot):
    w, c = setup(qtbot)
    assert w.template_combo.count() == 2
    preview(qtbot, w)
    assert w.preview_body.toPlainText() == c.preview["content"]
    assert w.preview_body.isReadOnly()
    w.issue()
    assert c.calls == []
    w.reviewed.setChecked(True)
    w.issue()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0]["expected_preview"] == c.preview
    assert w.history_list.count() == 1
    assert "서명 상태 별도 확인" in w.history_info.text()
    assert not w.issue_button.isEnabled()


def test_missing_field_blocks_issue_and_reload_resets_review(qtbot):
    w, c = setup(qtbot)
    c.preview["missing_fields"] = ["customer.phone"]
    preview(qtbot, w)
    assert "연락처" in w.preview_info.text()
    w.reviewed.setChecked(True)
    w.issue()
    assert c.calls == []
    c.preview["missing_fields"] = []
    w.load_preview()
    qtbot.waitUntil(lambda: not w.busy)
    assert not w.reviewed.isChecked()


def test_uncertain_result_retry_is_identical_and_close_can_cancel(qtbot, monkeypatch):
    w, c = setup(qtbot)
    preview(qtbot, w)
    w.reviewed.setChecked(True)
    c.issue_error = RuntimeError("lost response")
    w.issue()
    qtbot.waitUntil(lambda: not w.busy)
    assert w.pending is not None
    assert not w.template_combo.isEnabled()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    c.issue_error = None
    w.retry_issue()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0] == c.calls[1]
    assert w.history_list.count() == 1


def test_stale_preview_kept_but_cannot_issue_without_new_review(qtbot):
    w, c = setup(qtbot)
    preview(qtbot, w)
    w.reviewed.setChecked(True)
    c.issue_error = httpx.HTTPStatusError(
        "changed", request=httpx.Request("POST", "https://test"), response=httpx.Response(409)
    )
    w.issue()
    qtbot.waitUntil(lambda: not w.busy)
    assert w.preview_body.toPlainText() == c.preview["content"]
    assert not w.issue_button.isEnabled()
    assert not w.reviewed.isChecked()
    assert w.pending is None


def test_member_readonly_and_load_error_is_not_empty_history(qtbot):
    w, c = setup(qtbot, can_manage=False)
    preview(qtbot, w)
    w.reviewed.setChecked(True)
    w.issue()
    assert c.calls == []
    assert not w.reviewed.isEnabled()
    c = Client()
    c.load_error = True
    w, c = setup(qtbot, client=c)
    assert "불러오지 못" in w.status.text()
    assert not w.preview_button.isEnabled()


def test_selection_clears_previous_preview_and_review(qtbot):
    w, _ = setup(qtbot)
    preview(qtbot, w)
    w.reviewed.setChecked(True)
    w.template_combo.setCurrentIndex(0)
    assert not w.reviewed.isChecked()
    assert w.preview_body.toPlainText() == ""
    assert not w.issue_button.isEnabled()


def test_window_close_protects_unissued_review(qtbot, monkeypatch):
    w, _ = setup(qtbot)
    preview(qtbot, w)
    w.show()
    w.reviewed.setChecked(True)
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.close()
    assert w.isVisible()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Discard)
    with qtbot.waitSignal(w.finished):
        w.close()


def test_treatment_page_opens_scoped_dialog_and_guards_parent_navigation(qtbot, monkeypatch):
    from test_treatment_page import Client as TreatmentClient
    from test_treatment_page import page

    class LinkedClient(TreatmentClient, Client):
        def __init__(self):
            TreatmentClient.__init__(self)
            Client.__init__(self)
            self.scope = None

        def list_issued_treatment_documents(self, org, customer, treatment):
            self.scope = (org, customer, treatment)
            return []

    client = LinkedClient()
    w, _ = page(qtbot, client=client)
    w.history_table.setCurrentCell(0, 0)
    w._show_documents()
    dialog = w._documents_dialog
    assert dialog is not None
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.scope == (w.organization_id, client.customers[0].id, client.records[0].id)
    preview(qtbot, dialog)
    dialog.reviewed.setChecked(True)
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Discard)
    dialog.reject()


def test_unsaved_treatment_must_be_saved_before_issuance(qtbot):
    from test_treatment_page import page

    w, _ = page(qtbot)
    w.history_table.setCurrentCell(0, 0)
    w.form.notes_input.setPlainText("미저장 시술 기록")
    w._show_documents()
    assert w._documents_dialog is None
    assert "먼저 저장" in w.status_label.text()


def test_preview_shows_customer_identity_even_for_static_template(qtbot):
    w, c = setup(qtbot)
    c.preview["content"] = "정적인 안내문"
    c.preview["source_snapshot"] = {
        "customer": {"name": "<b>고객</b>", "phone": "01012345678"},
        "treatment": {"name": "수분 관리", "date": "2026-09-23"},
    }
    preview(qtbot, w)
    assert "<b>고객</b>" in w.preview_info.text()
    assert "수분 관리" in w.preview_info.text()
