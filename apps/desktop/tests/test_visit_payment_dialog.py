from copy import deepcopy
from uuid import uuid4

from business_assistant_desktop.visit_payment_dialog import (
    VisitPaymentDialog,
    VisitProductReturnDialog,
    VisitRefundDialog,
)
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
        self.cart = dict(cart={"version": 2}, lines=[])

    def get_sale_cart(self, *args):
        return deepcopy(self.cart)

    def return_visit_product(self, org, visit, payload):
        self.calls.append(deepcopy(payload))
        return deepcopy(self.result)

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

    def refund_visit_payment(self, org, visit, payload):
        self.calls.append(deepcopy(payload))
        amount = int(payload["amount"])
        self.result.update(
            paid_amount=str(100000 - amount),
            outstanding_amount=str(amount),
            refunded_amount=str(amount),
            status="void",
            cart_version=3,
            refunds=[
                {
                    "id": str(uuid4()),
                    "source_id": payload["source_id"],
                    "source_kind": "receipt",
                    "amount": str(amount),
                    "reason": payload["reason"],
                    "created_at": "2026-10-07T10:00:00+09:00",
                    "operation_id": payload["operation_id"],
                }
            ],
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


def test_product_return_screen_lists_only_remaining_quantities(qtbot, tmp_path):
    client = Client()
    client.cart = dict(
        cart={"version": 2},
        lines=[
            dict(
                id=str(uuid4()),
                source_type="product",
                status="active",
                quantity=3,
                returned_quantity=1,
                unit_price="12000",
                description_snapshot="크림",
            ),
            dict(
                id=str(uuid4()),
                source_type="treatment_draft",
                status="active",
                quantity=1,
                returned_quantity=0,
                unit_price="10000",
                description_snapshot="시술",
            ),
        ],
    )
    client.result.update(status="void", cart_version=2)
    client.result["receipts"] = [
        dict(id=str(uuid4()), method="card", amount="36000", reference="승인123")
    ]
    store = QSettings(str(tmp_path / "returns.ini"), QSettings.Format.IniFormat)
    page = VisitProductReturnDialog(
        client, ORG, VISIT, can_manage=True, recovery_identity="test", recovery_store=store
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    assert page.table.rowCount() == 1
    assert page.table.item(0, 3).text() == "2"
    assert page.line_select.count() == 1
    assert page.receipt_select.count() == 1


def test_product_return_persists_request_before_sending(qtbot, tmp_path):
    client = Client()
    line_id, receipt_id = uuid4(), uuid4()
    client.cart = dict(
        cart={"version": 2},
        lines=[
            dict(id=str(line_id), source_type="product", status="active", quantity=1,
                returned_quantity=0,
                unit_price="12000",
                line_total="12000",
                description_snapshot="크림",
            )
        ],
    )
    client.result["receipts"] = [
        dict(id=str(receipt_id), method="card", amount="12000", reference="승인123")
    ]
    store = QSettings(str(tmp_path / "return-submit.ini"), QSettings.Format.IniFormat)
    page = VisitProductReturnDialog(
        client, ORG, VISIT, can_manage=True, recovery_identity="test", recovery_store=store
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.amount_input.setText("12000")
    page.reason_input.setText("미개봉 반품")
    page.confirmed.setChecked(True)
    page._save()
    qtbot.waitUntil(lambda: len(client.calls) == 1 and not page.busy)
    request = client.calls[0]
    assert request["sale_line_id"] == str(line_id)
    assert request["receipt_id"] == str(receipt_id)
    assert request["quantity"] == 1
    assert request["restock"] is True
    assert request["amount"] == "12000"
    assert request["confirmed"] is True


def test_discounted_product_return_cannot_exceed_allocated_net_value(qtbot, tmp_path):
    client = Client()
    line_id, receipt_id = uuid4(), uuid4()
    client.cart = dict(
        cart={"version": 2},
        lines=[
            dict(
                id=str(line_id), source_type="product", status="active", quantity=2,
                returned_quantity=0, returned_refund_amount="0", returned_discount_amount="0",
                discount_share="20", unit_price="100", line_total="200",
                description_snapshot="크림",
            )
        ],
    )
    client.result["receipts"] = [
        dict(id=str(receipt_id), method="card", amount="180", reference="승인123")
    ]
    store = QSettings(str(tmp_path / "discounted-return.ini"), QSettings.Format.IniFormat)
    page = VisitProductReturnDialog(
        client, ORG, VISIT, can_manage=True, recovery_identity="test", recovery_store=store
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.quantity.setValue(1)
    page.amount_input.setText("91")
    page.reason_input.setText("반품")
    page.confirmed.setChecked(True)
    page._save()
    assert client.calls == []
    assert "상품 금액" in page.status_label.text()


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


def test_refund_dialog_records_original_receipt_with_reason(qtbot, tmp_path):
    client = Client()
    receipt_id = uuid4()
    client.result.update(
        paid_amount="100000",
        outstanding_amount="0",
        status="paid",
        receipts=[
            {
                "id": str(receipt_id),
                "method": "card",
                "amount": "100000",
                "reference": "approval-1",
                "received_at": "2026-10-07T09:00:00+09:00",
                "operation_id": str(uuid4()),
            }
        ],
    )
    store = QSettings(str(tmp_path / "refund.ini"), QSettings.Format.IniFormat)
    page = VisitRefundDialog(
        client,
        ORG,
        VISIT,
        can_manage=True,
        recovery_identity="identity",
        recovery_store=store,
    )
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.amount_input.setText("30000")
    page.reason_input.setText("고객 요청")
    page.confirmed.setChecked(True)
    page.save_button.click()
    qtbot.waitUntil(lambda: not page.busy)
    assert client.calls[-1]["source_id"] == str(receipt_id)
    assert client.calls[-1]["reason"] == "고객 요청"
    assert page.snapshot["refunded_amount"] == "30000"
