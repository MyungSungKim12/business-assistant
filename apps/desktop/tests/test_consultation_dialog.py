from dataclasses import replace
from uuid import uuid4

from business_assistant_desktop.consultation_dialog import ConsultationDialog, caution_snapshot
from PySide6.QtWidgets import QMessageBox
from test_treatment_page import Client


def dialog(qtbot, *, status="draft", can_manage=True, fail=False):
    client = Client()
    customer = client.customers[0]
    record = replace(client.records[0], status=status)
    calls = []

    def save(payload):
        calls.append(payload)
        if fail:
            raise RuntimeError("offline")
        return replace(
            record,
            version=2,
            consultation_goal=payload["values"]["goal"],
            consultation_plan=payload["values"]["plan"],
            cautions_snapshot=caution_snapshot(customer),
            cautions_acknowledged_by=uuid4(),
            cautions_acknowledged_at="2026-09-22T00:00:00Z",
        )

    widget = ConsultationDialog(customer, record, save, can_manage=can_manage)
    qtbot.addWidget(widget)
    return widget, calls


def test_save_consultation_payload_and_success(qtbot):
    w, calls = dialog(qtbot)
    w.goal_input.setPlainText("보습 관리 상담")
    w.plan_input.setPlainText("자극 반응 확인 후 진행")
    w.ack_checkbox.setChecked(True)
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert calls[0]["action"] == "consult"
    assert calls[0]["expected_version"] == 1
    assert calls[0]["values"]["expected_cautions"]["allergies"] == "향료 주의"
    assert not w.dirty()


def test_failure_keeps_input_and_reuses_id(qtbot, monkeypatch):
    w, calls = dialog(qtbot, fail=True)
    w.goal_input.setPlainText("작성중")
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert w.dirty()
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert calls[0]["operation_id"] == calls[1]["operation_id"]
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    w.reject()
    assert w.goal_input.toPlainText() == "작성중"
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Discard
    )
    w.reject()


def test_completed_and_member_are_readonly(qtbot):
    for options in ({"status": "completed"}, {"can_manage": False}):
        w, calls = dialog(qtbot, **options)
        w._save()
        assert calls == []
        assert w.goal_input.isReadOnly()
        assert not w.save_button.isEnabled()


def test_changed_customer_requires_fresh_confirmation(qtbot):
    client = Client()
    customer = client.customers[0]
    record = replace(
        client.records[0],
        status="draft",
        cautions_snapshot={"allergies": "old"},
        cautions_acknowledged_by=uuid4(),
        cautions_acknowledged_at="2026-09-21T01:00:00Z",
    )
    w = ConsultationDialog(customer, record, lambda p: record)
    qtbot.addWidget(w)
    assert not w.ack_checkbox.isChecked()
    assert "다시 확인" in w.confirmation_label.text()


def test_plain_text_preserved_and_lengths_rejected(qtbot):
    client = Client()
    record = replace(client.records[0], status="draft", consultation_goal="<b>고객 요청</b>")
    calls = []
    w = ConsultationDialog(client.customers[0], record, lambda p: calls.append(p))
    qtbot.addWidget(w)
    assert w.goal_input.toPlainText() == "<b>고객 요청</b>"
    w.goal_input.setPlainText("x" * 2001)
    w._save()
    assert calls == []
    assert "2,000" in w.status_label.text()
    w._baseline = w.values()


def test_parent_blocks_start_without_consultation(qtbot):
    from test_treatment_lifecycle import LifecycleClient
    from test_treatment_page import page

    client = LifecycleClient()
    client.records = [replace(client.records[0], consultation_goal="")]
    w, c = page(qtbot, client)
    w.history_table.setCurrentCell(0, 0)
    w._transition("start")
    assert c.mutations == []
    assert "상담 기록" in w.status_label.text()


def test_parent_consultation_open_reads_fresh_customer(qtbot):
    from test_treatment_lifecycle import LifecycleClient
    from test_treatment_page import page

    w, c = page(qtbot, LifecycleClient())
    w.history_table.setCurrentCell(0, 0)
    c.customers = [replace(c.customers[0], allergies="새로운 주의사항")] + c.customers[1:]
    w._show_consultation()
    qtbot.waitUntil(lambda: w._consultation_dialog is not None)
    dialog = w._consultation_dialog
    assert "새로운 주의사항" in dialog.cautions_label.text()
    assert not dialog.ack_checkbox.isChecked()
    dialog.reject()
