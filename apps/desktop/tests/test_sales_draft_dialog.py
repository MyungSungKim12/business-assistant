from copy import deepcopy
from dataclasses import replace
from uuid import uuid4

from business_assistant_desktop.sales_draft_dialog import SalesDraftDialog, SalesDraftInbox
from PySide6.QtWidgets import QMessageBox
from test_treatment_page import Client as Treatments


class Client:
    def __init__(self):
        self.calls = []
        self.rows = []
        self.fail = False

    def list_treatment_sale_drafts(self, *args):
        return self.rows

    def list_issued_treatment_documents(self, *args):
        return []

    def preview_treatment_sale_draft(self, org, customer, treatment, values):
        return {
            "values": values,
            "total_amount": values["amount"],
            "line": {
                "description": values["description"],
                "quantity": 1,
                "unit_price": values["amount"],
                "line_total": values["amount"],
                "practitioner": "담당",
            },
            "source_snapshot": {"customer": {"name": "고객"}, "treatment": {"version": 3}},
            "consent_status": "not_linked",
            "warnings": ["동의 문서 예외 사유 기록"],
        }

    def create_treatment_sale_draft(self, org, customer, treatment, payload):
        self.calls.append(deepcopy(payload))
        if self.fail:
            raise RuntimeError("lost response")
        p = payload["expected_preview"]
        row = {
            "id": str(uuid4()),
            "description": p["values"]["description"],
            "amount": p["total_amount"],
            "source_snapshot": p["source_snapshot"],
            "status": "draft",
            "created_at": "2026-09-28T00:00:00Z",
        }
        self.rows = [row]
        return row


def setup(qtbot, status="completed"):
    c = Client()
    record = replace(Treatments().records[0], status=status, version=3)
    w = SalesDraftDialog(c, uuid4(), record, can_manage=True)
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: not w.busy)
    return w, c


def review(qtbot, w):
    w.exception_reason.setPlainText("서식 미사용 사유")
    w.load_preview()
    qtbot.waitUntil(lambda: not w.busy)
    w.confirmed.setChecked(True)


def test_completed_review_creates_once_without_marking_paid(qtbot):
    w, c = setup(qtbot)
    review(qtbot, w)
    w.create()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0]["confirmed"] is True
    assert "결제 완료" not in w.result.toPlainText()
    assert "미수납" in w.result.toPlainText()
    w.create()
    assert len(c.calls) == 1


def test_cancelled_requires_actual_input_instead_of_original_amount(qtbot):
    w, c = setup(qtbot, "cancelled")
    assert w.amount.text() == ""
    assert w.description.text() == ""
    w.load_preview()
    assert w.preview is None
    w.description.setText("실제 수행한 세안")
    w.amount.setText("0")
    w.partial_reason.setPlainText("중단 전 세안만 수행, 무상 처리")
    review(qtbot, w)
    assert w.preview["total_amount"] == "0"
    w.confirmed.setChecked(False)
    w._baseline = w._inputs()


def test_lost_response_retries_same_payload_and_protects_close(qtbot, monkeypatch):
    w, c = setup(qtbot)
    review(qtbot, w)
    c.fail = True
    w.create()
    qtbot.waitUntil(lambda: not w.busy)
    assert w.pending is not None
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    c.fail = False
    w.retry()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0] == c.calls[1]


def test_edit_invalidates_review(qtbot):
    w, _ = setup(qtbot)
    review(qtbot, w)
    w.amount.setText("12500")
    assert w.preview is None
    assert not w.confirmed.isChecked()
    w._baseline = w._inputs()


def test_existing_draft_is_read_only_and_reload_preserves_unsaved_input(qtbot, monkeypatch):
    w, c = setup(qtbot)
    w.description.setText("작성하던 청구 내용")
    c.rows = [
        {
            "id": str(uuid4()),
            "description": "다른 관리자가 전달한 초안",
            "amount": "500.00",
            "source_snapshot": {},
        }
    ]
    w.reload()
    qtbot.waitUntil(lambda: not w.busy)
    assert not w.create_button.isEnabled()
    assert w.description.text() == "작성하던 청구 내용"
    assert "다른 관리자가 전달한 초안" in w.result.toPlainText()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    w._baseline = w._inputs()


def test_member_cannot_create_and_inbox_displays_snapshot(qtbot):
    c = Client()
    c.rows = [
        {
            "description": "검토 명세",
            "amount": "100.01",
            "source_snapshot": {"customer": {"name": "전달 당시 이름"}},
        }
    ]
    w = SalesDraftDialog(
        c, uuid4(), replace(Treatments().records[0], status="completed"), can_manage=False
    )
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: not w.busy)
    assert not w.create_button.isEnabled()
    w.create()
    assert c.calls == []
    inbox = SalesDraftInbox(c, uuid4())
    qtbot.addWidget(inbox)
    qtbot.waitUntil(lambda: not inbox.busy)
    inbox.list.setCurrentRow(0)
    assert "전달 당시 이름" in inbox.detail.toPlainText()
    assert "미수납" in inbox.detail.toPlainText()
    assert "100.01" in inbox.detail.toPlainText()
