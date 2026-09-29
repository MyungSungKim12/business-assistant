from threading import Event
from types import SimpleNamespace
from uuid import uuid4

from business_assistant_desktop.customer_activity_panel import CustomerActivityPanel


class Client:
    def __init__(self):
        self.calls = []
        self.fail = False

    def list_customer_activities(self, org, customer):
        return []

    def create_customer_activity(self, org, customer, values):
        self.calls.append(values)
        if self.fail:
            raise RuntimeError("offline")
        return SimpleNamespace(
            id=uuid4(), customer_id=customer, occurred_at="2026-09-17T10:00:00Z", **values
        )


def panel(qtbot, client=None, manage=True):
    client = client or Client()
    widget = CustomerActivityPanel(client, uuid4(), can_manage=manage)
    qtbot.addWidget(widget)
    widget.set_customer(uuid4())
    qtbot.waitUntil(lambda: widget.status_label.text() == "등록된 활동이 없습니다.")
    return widget, client


def test_save_success_updates_history_and_clears_draft(qtbot):
    widget, client = panel(qtbot)
    widget.title_input.setText("상담")
    widget.description_input.setPlainText("민감 피부")
    assert widget.has_unsaved_changes()
    widget.save_button.click()
    qtbot.waitUntil(lambda: not widget.is_saving)
    assert len(client.calls) == 1
    assert "상담" in widget.history_label.text()
    assert "민감 피부" in widget.history_label.text()
    assert not widget.has_unsaved_changes()


def test_failed_save_preserves_draft_and_retry(qtbot):
    widget, client = panel(qtbot)
    client.fail = True
    widget.title_input.setText("상담")
    widget.save_button.click()
    qtbot.waitUntil(lambda: not widget.is_saving)
    assert widget.title_input.text() == "상담"
    assert "실패" in widget.status_label.text()
    client.fail = False
    widget.save_button.click()
    qtbot.waitUntil(lambda: not widget.is_saving)
    assert "상담" in widget.history_label.text()


def test_stale_customer_response_is_ignored(qtbot):
    gate = Event()
    first, second = uuid4(), uuid4()

    class SlowClient(Client):
        def list_customer_activities(self, org, customer):
            if customer == first:
                gate.wait(3)
            return [
                SimpleNamespace(
                    id=uuid4(),
                    customer_id=customer,
                    activity_type="note",
                    title=str(customer),
                    description="",
                    occurred_at="2026-09-17",
                )
            ]

    widget = CustomerActivityPanel(SlowClient(), uuid4())
    qtbot.addWidget(widget)
    widget.set_customer(first)
    widget.set_customer(second)
    qtbot.waitUntil(lambda: str(second) in widget.history_label.text())
    gate.set()
    qtbot.waitUntil(lambda: not widget._workers)
    assert str(first) not in widget.history_label.text()


def test_read_only_and_validation_never_send(qtbot):
    widget, client = panel(qtbot, manage=False)
    widget.title_input.setText("상담")
    widget._save()
    assert client.calls == []
    assert not widget.add_button.isEnabled()
    assert not widget.save_button.isEnabled()
    widget2, client2 = panel(qtbot)
    widget2._save()
    widget2.title_input.setText("상담")
    widget2.description_input.setPlainText("a" * 10001)
    widget2._save()
    assert client2.calls == []
    widget2.discard_draft()
    assert not widget2.has_unsaved_changes()


def test_activity_load_failure_retries_without_losing_composer(qtbot):
    class FlakyClient(Client):
        load_failed = True

        def list_customer_activities(self, org, customer):
            if self.load_failed:
                raise RuntimeError("offline")
            return []

    client = FlakyClient()
    widget = CustomerActivityPanel(client, uuid4())
    qtbot.addWidget(widget)
    widget.set_customer(uuid4())
    qtbot.waitUntil(lambda: "불러오지 못" in widget.status_label.text())
    widget.title_input.setText("보존할 상담")
    client.load_failed = False
    widget.retry_button.click()
    qtbot.waitUntil(lambda: not widget.is_loading)
    assert "등록된 활동이 없습니다" in widget.status_label.text()
    assert widget.title_input.text() == "보존할 상담"


def test_pending_save_blocks_duplicate_and_customer_switch(qtbot):
    gate = Event()

    class SlowSaveClient(Client):
        def create_customer_activity(self, org, customer, values):
            gate.wait(2)
            return super().create_customer_activity(org, customer, values)

    widget, client = panel(qtbot, SlowSaveClient())
    selected = widget._customer_id
    widget.title_input.setText("상담")
    widget._save()
    widget._save()
    widget.set_customer(uuid4())
    assert widget._customer_id == selected
    assert widget.is_saving
    gate.set()
    qtbot.waitUntil(lambda: not widget.is_saving)
    assert len(client.calls) == 1
