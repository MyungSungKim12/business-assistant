from dataclasses import replace
from uuid import uuid4

import httpx
from business_assistant_desktop.document_page import DocumentTemplate
from business_assistant_desktop.template_manager import TemplateManager
from PySide6.QtWidgets import QMessageBox


class Client:
    def __init__(self):
        self.row = DocumentTemplate(uuid4(), "동의서", "<b>본문</b>")
        self.calls = []
        self.error = None

    def list_document_templates(self, org):
        return [self.row]

    def list_document_template_versions(self, org, template):
        return [
            {
                "version": 1,
                "published_at": "2026-09-22",
                "published_by": str(uuid4()),
                "name": "옛 이름",
                "description": "",
                "content": "예전 본문",
            }
        ]

    def mutate_document_template(self, org, template, payload):
        self.calls.append((template, payload.copy()))
        if self.error:
            raise self.error
        self.row = replace(
            self.row, id=template, revision=self.row.revision + 1, **payload.get("values", {})
        )
        return self.row


def setup(qtbot, **kwargs):
    client = Client()
    widget = TemplateManager(client, uuid4(), can_manage=kwargs.get("can_manage", True))
    qtbot.addWidget(widget)
    qtbot.waitUntil(lambda: not widget.busy)
    return widget, client


def test_new_draft_save_and_plain_text(qtbot):
    w, c = setup(qtbot)
    w.name.setText("상담 동의서")
    w.content.setPlainText("<b>본문</b>")
    w.mutate("save")
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0][1]["action"] == "create"
    assert c.calls[0][1]["expected_revision"] == 0
    assert w.content.toPlainText() == "<b>본문</b>"
    assert not w.dirty()


def test_uncertain_retry_preserves_input_and_operation(qtbot, monkeypatch):
    w, c = setup(qtbot)
    c.error = RuntimeError("offline")
    w.name.setText("새 서식")
    w.content.setPlainText("작성 중")
    w.mutate("save")
    qtbot.waitUntil(lambda: not w.busy)
    assert w.content.toPlainText() == "작성 중"
    assert w.pending is not None
    assert w.content.isReadOnly()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    c.error = None
    w._retry()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0] == c.calls[1]
    assert w.pending is None


def test_selection_cancel_preserves_draft(qtbot, monkeypatch):
    w, _ = setup(qtbot)
    w.name.setText("작성 중")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    w.list.setCurrentRow(0)
    assert w.name.text() == "작성 중"
    assert w.list.currentRow() == -1
    assert not w.confirm_leave()


def test_history_is_readonly_and_returns_to_current(qtbot):
    w, _ = setup(qtbot)
    w.list.setCurrentRow(0)
    qtbot.waitUntil(lambda: not w.busy)
    w.history.setCurrentIndex(1)
    assert w.content.toPlainText() == "예전 본문"
    assert w.content.isReadOnly()
    assert not w.buttons["save"].isEnabled()
    w.history.setCurrentIndex(0)
    assert w.content.toPlainText() == "<b>본문</b>"
    assert not w.dirty()


def test_member_cannot_write_even_programmatically(qtbot):
    w, c = setup(qtbot, can_manage=False)
    w.mutate("save")
    assert c.calls == []
    assert w.content.isReadOnly()
    assert not w.new_button.isEnabled()


def test_conflict_keeps_input_and_requires_reload(qtbot):
    w, c = setup(qtbot)
    w.list.setCurrentRow(0)
    qtbot.waitUntil(lambda: not w.busy)
    w.content.setPlainText("충돌한 초안")
    c.error = httpx.HTTPStatusError(
        "conflict", request=httpx.Request("POST", "https://test"), response=httpx.Response(409)
    )
    w.mutate("save")
    qtbot.waitUntil(lambda: not w.busy)
    assert w.content.toPlainText() == "충돌한 초안"
    assert w.conflict
    assert w.pending is None
    assert not w.buttons["save"].isEnabled()
    # Verify retained input first, then avoid a modal prompt during Qt teardown.
    w._baseline = w.fields()


def test_window_close_emits_finished_without_double_confirmation(qtbot, monkeypatch):
    w, _ = setup(qtbot)
    w.show()
    w.name.setText("작성 중")
    confirmations = []

    def discard(*args, **kwargs):
        confirmations.append(True)
        return QMessageBox.StandardButton.Discard

    monkeypatch.setattr(QMessageBox, "question", discard)
    with qtbot.waitSignal(w.finished):
        w.close()
    assert len(confirmations) == 1


def test_explicit_close_emits_finished(qtbot):
    w, _ = setup(qtbot)
    w.show()
    with qtbot.waitSignal(w.finished):
        w.reject()


def test_insert_prefill_token_only_in_editable_draft(qtbot):
    w, _ = setup(qtbot)
    w.field_combo.setCurrentIndex(0)
    w._insert_field()
    assert w.content.toPlainText() == "{{customer.name}}"
    w.content.clear()
    w.can_manage = False
    w._controls()
    w._insert_field()
    assert w.content.toPlainText() == ""
