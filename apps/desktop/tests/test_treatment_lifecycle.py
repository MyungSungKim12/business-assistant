from dataclasses import replace
from uuid import uuid4

from business_assistant_desktop.consultation_dialog import caution_snapshot
from test_treatment_page import Client, page


class LifecycleClient(Client):
    def __init__(self):
        super().__init__()
        self.records = [
            replace(
                self.records[0],
                status="draft",
                version=1,
                consultation_goal="보습 상담",
                cautions_snapshot=caution_snapshot(self.customers[0]),
                cautions_acknowledged_by=uuid4(),
                cautions_acknowledged_at="2026-09-22T00:00:00Z",
            )
        ]
        self.mutations = []

    def mutate_treatment(self, org, customer, record_id, payload):
        self.mutations.append(payload)
        if self.fail:
            raise RuntimeError("offline")
        record = next(r for r in self.records if r.id == record_id)
        state = {"start": "in_progress", "complete": "completed", "cancel": "cancelled"}.get(
            payload["action"], record.status
        )
        values = payload.get("values") or {}
        updated = replace(record, status=state, version=record.version + 1, **values)
        self.records[self.records.index(record)] = updated
        return updated

    def list_treatment_events(self, *args):
        return []


def test_start_complete_then_reasoned_correction(qtbot):
    w, c = page(qtbot, LifecycleClient())
    w.history_table.setCurrentCell(0, 0)
    assert w.lifecycle.start_button.isEnabled()
    w._transition("start")
    qtbot.waitUntil(lambda: not w.is_saving)
    assert c.records[0].status == "in_progress"
    w._transition("complete")
    qtbot.waitUntil(lambda: not w.is_saving)
    assert w.form.name_input.isReadOnly()
    assert not w.save_button.isEnabled()
    w._begin_correction()
    w.form.notes_input.setPlainText("정정 내용")
    w._save()
    assert len(c.mutations) == 2
    w.lifecycle.reason_input.setText("담당자 기록 누락 보완")
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert c.mutations[-1]["action"] == "correct"
    assert c.mutations[-1]["expected_version"] == 3
    assert c.records[0].status == "completed"


def test_retry_reuses_operation_id_and_preserves_draft(qtbot):
    w, c = page(qtbot, LifecycleClient())
    w.history_table.setCurrentCell(0, 0)
    c.fail = True
    w._transition("start")
    qtbot.waitUntil(lambda: not w.is_saving)
    first = c.mutations[-1]["operation_id"]
    c.fail = False
    w._transition("start")
    qtbot.waitUntil(lambda: not w.is_saving)
    assert c.mutations[-1]["operation_id"] == first
    assert len(c.mutations) == 2


def test_legacy_is_not_assumed_completed_and_member_cannot_start(qtbot):
    w, c = page(qtbot)
    w.history_table.setCurrentCell(0, 0)
    assert "기존 기록" in w.lifecycle.state_label.text()
    assert not w.lifecycle.start_button.isEnabled()
    member, client = page(qtbot, LifecycleClient(), can_manage=False)
    member.history_table.setCurrentCell(0, 0)
    member._transition("start")
    assert client.mutations == []


def test_dirty_form_blocks_state_transition(qtbot):
    w, c = page(qtbot, LifecycleClient())
    w.history_table.setCurrentCell(0, 0)
    w.form.notes_input.setPlainText("작성 중")
    w._transition("start")
    assert c.mutations == []
    assert "저장" in w.status_label.text()


def test_cancel_failure_prefills_reason_for_identical_retry(qtbot, monkeypatch):
    from PySide6.QtWidgets import QInputDialog

    w, c = page(qtbot, LifecycleClient())
    w.history_table.setCurrentCell(0, 0)
    values = []

    def reason(*args, **kwargs):
        values.append(kwargs.get("text"))
        return "고객 요청으로 중단", True

    monkeypatch.setattr(QInputDialog, "getText", reason)
    c.fail = True
    w._transition("cancel")
    qtbot.waitUntil(lambda: not w.is_saving)
    c.fail = False
    w._transition("cancel")
    qtbot.waitUntil(lambda: not w.is_saving)
    assert values == ["", "고객 요청으로 중단"]
    assert c.mutations[0]["operation_id"] == c.mutations[1]["operation_id"]


def test_conflict_keeps_input_and_reload_updates_version(qtbot, monkeypatch):
    import httpx
    from PySide6.QtWidgets import QMessageBox

    class Conflict(LifecycleClient):
        def mutate_treatment(self, *args):
            self.records[0] = replace(self.records[0], version=2, notes="다른 직원 수정")
            response = httpx.Response(409, request=httpx.Request("POST", "https://api.test"))
            raise httpx.HTTPStatusError("conflict", request=response.request, response=response)

    w, c = page(qtbot, Conflict())
    w.history_table.setCurrentCell(0, 0)
    w.form.notes_input.setPlainText("내가 쓴 기록")
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert w.form.notes_input.toPlainText() == "내가 쓴 기록"
    assert not w.save_button.isEnabled()
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Discard
    )
    w._reload()
    qtbot.waitUntil(lambda: not w.is_loading)
    assert w._record().version == 2
    assert w.form.notes_input.toPlainText() == "다른 직원 수정"
    assert w.save_button.isEnabled()


def test_audit_zero_and_stale_dialog_error(qtbot):
    from threading import Event

    from business_assistant_desktop.treatment_lifecycle import TreatmentEventsDialog

    gate = Event()

    class Events(LifecycleClient):
        count = 0

        def list_treatment_events(self, *args):
            self.count += 1
            if self.count == 1:
                gate.wait(2)
                raise RuntimeError("old request failed")
            return []

    w, c = page(qtbot, Events())
    w.history_table.setCurrentCell(0, 0)
    w._show_events()
    qtbot.waitUntil(lambda: c.count == 1)
    old = w._events_dialog
    old.close()
    w._show_events()
    qtbot.waitUntil(lambda: "저장된 변경" in w._events_dialog.text.toPlainText())
    gate.set()
    qtbot.waitUntil(lambda: not w._workers)
    assert "저장된 변경" in w._events_dialog.text.toPlainText()
    w._events_dialog.close()
    dialog = TreatmentEventsDialog(w)
    dialog.display([dict(action="correct", before_data={"amount": 100}, after_data={"amount": 0})])
    assert "100 → 0" in dialog.text.toPlainText()
