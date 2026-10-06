from copy import deepcopy
from uuid import uuid4

from business_assistant_desktop.visit_payment_dialog import VisitPaymentDialog
from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QMessageBox

ORG, VISIT = uuid4(), uuid4()


class Client:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.result = dict(
            visit_id=str(VISIT),
            cart_id=str(uuid4()),
            cart_version=2,
            total_amount="100000",
            paid_amount="0",
            outstanding_amount="100000",
            currency="KRW",
            status="ready",
            receipts=[],
        )

    def get_visit_payments(self, *args):
        return deepcopy(self.result)

    def record_visit_payment(self, org, visit, payload):
        self.calls.append(deepcopy(payload))
        if self.fail:
            raise TimeoutError("response lost")
        paid = sum(int(p["amount"]) for p in payload["payments"])
        self.result.update(
            paid_amount=str(paid),
            outstanding_amount=str(100000 - paid),
            status="paid" if paid == 100000 else "collecting",
            cart_version=3,
        )
        return deepcopy(self.result)


def dialog(qtbot, tmp_path, client=None, manage=True, identity="test-server/user-a"):
    store = QSettings(str(tmp_path / "recovery.ini"), QSettings.Format.IniFormat)
    page = VisitPaymentDialog(
        client or Client(),
        ORG,
        VISIT,
        can_manage=manage,
        recovery_store=store,
        recovery_identity=identity,
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    return page, store


def test_split_receipt_updates_balance_and_clears_inputs(qtbot, tmp_path):
    client = Client()
    page, store = dialog(qtbot, tmp_path, client)
    page.inputs["card"][0].setText("70000")
    page.inputs["card"][1].setText("approval1")
    page.inputs["cash"][0].setText("30000")
    page.confirmed.setChecked(True)
    page._save()
    qtbot.waitUntil(lambda: not page.busy)
    assert len(client.calls) == 1
    assert {p["method"] for p in client.calls[0]["payments"]} == {"cash", "card"}
    assert "미수 0원" in page.balance_label.text()
    assert not page.save_button.isEnabled()
    assert not store.contains(page._key)


def test_unknown_result_survives_close_and_reopen_with_same_operation(qtbot, tmp_path):
    client = Client()
    client.fail = True
    page, store = dialog(qtbot, tmp_path, client)
    page.inputs["cash"][0].setText("30000")
    page.confirmed.setChecked(True)
    page._save()
    qtbot.waitUntil(lambda: not page.busy)
    assert store.contains(page._key)
    assert page.confirm_leave()
    assert not page.save_button.isEnabled()
    original = deepcopy(client.calls[0])
    reopened, _ = dialog(qtbot, tmp_path, client)
    assert reopened.inputs["cash"][0].text() == "30000"
    reopened._retry()
    qtbot.waitUntil(lambda: not reopened.busy)
    assert client.calls[-1] == original
    page._pending = None
    page.confirmed.setChecked(False)
    page.inputs["cash"][0].clear()


def test_invalid_and_overpayment_never_submit(qtbot, tmp_path, monkeypatch):
    client = Client()
    page, _ = dialog(qtbot, tmp_path, client)
    page.inputs["cash"][0].setText("100001")
    page.confirmed.setChecked(True)
    page._save()
    assert not client.calls
    assert "미수금" in page.status_label.text()
    page.inputs["cash"][0].setText("1.5")
    page._save()
    assert not client.calls
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)


def test_unsaved_and_busy_close_protection(qtbot, tmp_path, monkeypatch):
    page, _ = dialog(qtbot, tmp_path)
    page.inputs["card"][0].setText("10000")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Cancel)
    assert not page.confirm_leave()
    page.busy = True
    assert not page.confirm_leave()
    page.busy = False
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)


def test_member_has_history_without_mutation(qtbot, tmp_path):
    client = Client()
    page, _ = dialog(qtbot, tmp_path, client, manage=False)
    assert not page.save_button.isEnabled()
    assert not page.inputs["cash"][0].isEnabled()
    page._save()
    assert not client.calls


def test_uncertain_result_then_auth_failure_keeps_recovery(qtbot, tmp_path):
    import httpx

    client = Client()
    client.fail = True
    page, store = dialog(qtbot, tmp_path, client)
    page.inputs["cash"][0].setText("30000")
    page.confirmed.setChecked(True)
    page._save()
    qtbot.waitUntil(lambda: not page.busy)
    response = httpx.Response(401, request=httpx.Request("POST", "https://example.test"))
    error = httpx.HTTPStatusError("expired", request=response.request, response=response)
    page._finished(("record", None, error))
    assert page._pending is not None
    assert store.contains(page._key)
    assert not page.save_button.isEnabled()


def test_bad_recovery_locks_new_payment_without_crashing(qtbot, tmp_path):
    store = QSettings(str(tmp_path / "recovery.ini"), QSettings.Format.IniFormat)
    from hashlib import sha256

    key = f"{sha256(b'test-server/user-a').hexdigest()}/{ORG}/{VISIT}"
    store.setValue(key, '{"operation_id": "bad"}')
    store.sync()
    page, _ = dialog(qtbot, tmp_path)
    assert not page.save_button.isEnabled()
    assert "관리자" in page.status_label.text()


def test_recovery_isolated_by_user_and_server(qtbot, tmp_path):
    client = Client()
    client.fail = True
    first, store = dialog(qtbot, tmp_path, client)
    first.inputs["cash"][0].setText("30000")
    first.confirmed.setChecked(True)
    first._save()
    qtbot.waitUntil(lambda: not first.busy)
    for identity in ("test-server/user-b", "other-server/user-a"):
        other, _ = dialog(qtbot, tmp_path, client, identity=identity)
        assert other._pending is None
        assert other.inputs["cash"][0].text() == ""
        other._retry()
        assert len(client.calls) == 1
    assert store.contains(first._key)


def test_failed_recovery_cleanup_keeps_retry_identity(qtbot):
    class Store:
        data = {}
        failed = False

        def value(self, key, default):
            return self.data.get(key, default)

        def setValue(self, key, value):
            self.data[key] = value

        def sync(self):
            pass

        def status(self):
            return QSettings.Status.AccessError if self.failed else QSettings.Status.NoError

        def remove(self, key):
            self.failed = True

    client, store = Client(), Store()
    page = VisitPaymentDialog(
        client,
        ORG,
        VISIT,
        can_manage=True,
        recovery_store=store,
        recovery_identity="test-server/user-a",
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.inputs["cash"][0].setText("30000")
    page.confirmed.setChecked(True)
    page._save()
    qtbot.waitUntil(lambda: not page.busy)
    assert page._pending["operation_id"] == client.calls[0]["operation_id"]
    assert page._uncertain
    assert not page.save_button.isEnabled()
