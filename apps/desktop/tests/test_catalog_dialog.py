from uuid import UUID

from business_assistant_desktop.catalog_dialog import (
    CatalogManagerDialog,
    CustomerWalletDialog,
    WalletUseDialog,
)
from PySide6.QtCore import Qt

ORG = UUID("11111111-1111-1111-1111-111111111111")
PRODUCT = UUID("22222222-2222-2222-2222-222222222222")
CUSTOMER = UUID("33333333-3333-3333-3333-333333333333")
VISIT = UUID("44444444-4444-4444-4444-444444444444")
LINE = UUID("55555555-5555-5555-5555-555555555555")
WALLET = UUID("66666666-6666-6666-6666-666666666666")


class Client:
    def __init__(self):
        self.rows = [
            {
                "id": str(PRODUCT),
                "organization_id": str(ORG),
                "sku": "P-1",
                "name": "보습 크림",
                "kind": "product",
                "unit_name": "개",
                "sale_price": "30000",
                "benefit_money": "0",
                "benefit_count": 0,
                "valid_days": None,
                "is_active": True,
                "version": 1,
                "stock_quantity": 2,
            }
        ]
        self.calls = []

    def list_catalog_products(self, organization_id):
        return self.rows

    def save_catalog_product(self, organization_id, product_id, payload):
        self.calls.append(("save", product_id, payload))
        row = {**self.rows[0], **payload, "id": str(product_id or PRODUCT), "version": 2}
        row.pop("operation_id")
        row.pop("expected_version", None)
        self.rows = [row]
        return row

    def receive_catalog_stock(self, organization_id, product_id, payload):
        self.calls.append(("stock", product_id, payload))
        self.rows[0] = {**self.rows[0], "stock_quantity": 5, "version": 3}
        return self.rows[0]

    def change_catalog_stock(self, organization_id, product_id, payload):
        self.calls.append(("stock_change", product_id, payload))
        self.rows[0] = {**self.rows[0], "stock_quantity": 1, "version": 2}
        return self.rows[0]

    def list_catalog_stock_ledger(self, organization_id, product_id):
        return [
            {
                "movement_kind": "supplier_return",
                "quantity": -1,
                "reason": "거래처 부분 반품",
                "created_at": "2026-10-08T10:00:00+09:00",
            }
        ]

    def list_customer_wallets(self, organization_id, customer_id):
        return [
            {
                "id": str(WALLET),
                "name_snapshot": "VIP 3회권",
                "money_balance": "50000",
                "count_balance": 3,
                "valid_from": "2030-01-01",
                "expires_on": "2030-03-31",
                "usage_history": [],
            }
        ]

    def use_customer_wallet(self, organization_id, visit_id, payload):
        self.calls.append(("use_wallet", visit_id, payload))
        return {
            "visit_id": str(visit_id),
            "cart_version": payload["expected_cart_version"] + 1,
            "outstanding_amount": "70000",
        }

    def manage_customer_wallet(self, organization_id, customer_id, wallet_id, payload):
        self.calls.append(("wallet_lifecycle", wallet_id, payload))
        return {"id": str(wallet_id), "lifecycle_status": "paused"}


class MemoryStore:
    def __init__(self):
        self.values = {}

    def value(self, key, default=""):
        return self.values.get(key, default)

    def setValue(self, key, value):
        self.values[key] = value

    def remove(self, key):
        self.values.pop(key, None)

    def sync(self):
        return None

    def status(self):
        from PySide6.QtCore import QSettings

        return QSettings.Status.NoError


def test_catalog_dialog_loads_selects_and_saves(qtbot):
    client = Client()
    dialog = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert dialog.table.rowCount() == 1
    dialog.table.selectRow(0)
    assert dialog.name_input.text() == "보습 크림"
    dialog.name_input.setText("리뉴얼 크림")
    qtbot.mouseClick(dialog.save_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.calls[0][0] == "save"
    assert client.calls[0][2]["expected_version"] == 1
    assert dialog.table.item(0, 1).text() == "리뉴얼 크림"


def test_membership_fields_and_stock_permissions(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    client = Client()
    dialog = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.new_button.click()
    dialog.kind_input.setCurrentIndex(1)
    assert dialog.benefit_money_input.isEnabled()
    assert not dialog.stock_button.isEnabled()
    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Discard)
    dialog.table.selectRow(0)
    dialog.stock_quantity_input.setValue(3)
    dialog.stock_reason_input.setText("정기 입고")
    qtbot.mouseClick(dialog.stock_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.calls[-1][0] == "stock"
    assert dialog.table.item(0, 4).text() == "5"

    readonly = CatalogManagerDialog(client, ORG, can_manage=False, recovery_store=MemoryStore())
    qtbot.addWidget(readonly)
    qtbot.waitUntil(lambda: not readonly.busy)
    assert not readonly.save_button.isEnabled()
    assert not readonly.stock_button.isEnabled()


def test_wallet_dialog_renders_balances(qtbot):
    dialog = CustomerWalletDialog(Client(), ORG, CUSTOMER)
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert dialog.table.rowCount() == 1
    assert dialog.table.item(0, 1).text() == "50,000원"
    assert dialog.table.item(0, 2).text() == "3회"


def test_wallet_pause_uses_reason_version_and_recovery(qtbot, monkeypatch):
    from PySide6.QtWidgets import QInputDialog

    client = Client()
    store = MemoryStore()
    dialog = CustomerWalletDialog(
        client, ORG, CUSTOMER, can_manage=True, recovery_store=store
    )
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.table.selectRow(0)
    monkeypatch.setattr(QInputDialog, "getText", lambda *args: ("고객 요청", True))
    dialog.pause_button.click()
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.calls[-1][0] == "wallet_lifecycle"
    assert client.calls[-1][2]["expected_version"] == 1
    assert client.calls[-1][2]["reason"] == "고객 요청"
    assert store.values == {}


def test_stock_adjustment_records_partial_return_with_product_version(qtbot):
    client = Client()
    dialog = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.table.selectRow(0)
    dialog.stock_change_kind.setCurrentIndex(dialog.stock_change_kind.findData("supplier_return"))
    dialog.stock_quantity_input.setValue(1)
    dialog.stock_reason_input.setText("거래처 부분 반품")
    dialog.stock_change_button.click()
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.calls[-1][0] == "stock_change"
    assert client.calls[-1][2]["kind"] == "supplier_return"
    assert client.calls[-1][2]["expected_version"] == 1
    assert client.calls[-1][2]["quantity"] == 1
    assert dialog.table.item(0, 4).text() == "1"


def test_stock_history_shows_auditable_reason_and_quantity(qtbot):
    dialog = CatalogManagerDialog(Client(), ORG, can_manage=False, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.table.selectRow(0)
    dialog.stock_history_button.click()
    qtbot.waitUntil(lambda: not dialog.busy)
    assert dialog.history_table is not None
    assert dialog.history_table.rowCount() == 1
    assert dialog.history_table.item(0, 1).text() == "거래처 반품"
    assert "거래처 부분 반품" in dialog.history_table.item(0, 3).text()


def wallet_bundle():
    return {
        "visit": {"id": str(VISIT)},
        "cart": {"version": 4, "status": "ready"},
        "lines": [
            {
                "id": str(LINE),
                "status": "active",
                "source_type": "treatment_draft",
                "description_snapshot": "피부 관리",
                "line_total": "100000",
            }
        ],
    }


def test_wallet_use_dialog_records_money_and_updates_local_balance(qtbot):
    client = Client()
    dialog = WalletUseDialog(
        client,
        ORG,
        CUSTOMER,
        wallet_bundle(),
        can_manage=True,
        recovery_store=MemoryStore(),
    )
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.amount_input.setText("30000")
    dialog.confirmed.setChecked(True)
    dialog.use_button.click()
    qtbot.waitUntil(lambda: not dialog.busy)
    call = client.calls[-1]
    assert call[0] == "use_wallet"
    assert call[2]["wallet_id"] == str(WALLET)
    assert call[2]["sale_line_id"] == str(LINE)
    assert call[2]["operation_id"]
    assert dialog.table.item(0, 1).text() == "20,000원"
    assert dialog.cart_version == 5


def test_wallet_use_unknown_result_keeps_same_operation_after_restart(qtbot):
    import httpx

    class UncertainClient(Client):
        payment_recovery_identity = "https://server\nuser"

        def use_customer_wallet(self, organization_id, visit_id, payload):
            self.calls.append(("use_wallet", visit_id, payload))
            if len(self.calls) == 1:
                raise httpx.ConnectError("unknown")
            request = httpx.Request("POST", "https://server/wallet")
            response = httpx.Response(401, request=request)
            raise httpx.HTTPStatusError("expired", request=request, response=response)

    store = MemoryStore()
    client = UncertainClient()
    first = WalletUseDialog(
        client, ORG, CUSTOMER, wallet_bundle(), can_manage=True, recovery_store=store
    )
    qtbot.addWidget(first)
    qtbot.waitUntil(lambda: not first.busy)
    first.amount_input.setText("1000")
    first.confirmed.setChecked(True)
    first.use_button.click()
    qtbot.waitUntil(lambda: not first.busy)
    operation = client.calls[-1][2]["operation_id"]
    second = WalletUseDialog(
        client, ORG, CUSTOMER, wallet_bundle(), can_manage=True, recovery_store=store
    )
    qtbot.addWidget(second)
    qtbot.waitUntil(lambda: not second.busy)
    second.retry_button.click()
    qtbot.waitUntil(lambda: not second.busy)
    assert client.calls[-1][2]["operation_id"] == operation
    assert store.values


def test_wallet_use_malformed_recovery_blocks_new_usage(qtbot):
    from hashlib import sha256

    client, store = Client(), MemoryStore()
    identity = "local-user"
    key = f"{sha256(identity.encode('utf-8')).hexdigest()}/{ORG}/{VISIT}"
    store.values[key] = "not-json"
    dialog = WalletUseDialog(
        client, ORG, CUSTOMER, wallet_bundle(), can_manage=True, recovery_store=store
    )
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert not dialog.use_button.isEnabled()
    assert "복구" in dialog.status_label.text()


def test_unsaved_catalog_form_blocks_close(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    dialog = CatalogManagerDialog(Client(), ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.table.selectRow(0)
    dialog.name_input.setText("작성 중")
    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Cancel)
    assert not dialog.confirm_leave()
    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Discard)
    assert dialog.confirm_leave()


def test_new_product_and_stock_draft_do_not_discard_without_confirmation(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    dialog = CatalogManagerDialog(Client(), ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.table.selectRow(0)
    dialog.name_input.setText("편집 중")
    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Cancel)
    dialog.new_button.click()
    assert dialog.selected_row == 0
    assert dialog.name_input.text() == "편집 중"

    dialog.name_input.setText("보습 크림")
    dialog.stock_reason_input.setText("입고 작성 중")
    assert not dialog.confirm_leave()
    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Discard)
    assert dialog.new_button.isEnabled()
    dialog.new_button.click()
    assert dialog.selected_row == -1
    assert dialog.stock_reason_input.text() == ""


def test_non_ascii_digits_are_validation_error(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(QMessageBox, "question", lambda *args: QMessageBox.StandardButton.Discard)
    dialog = CatalogManagerDialog(Client(), ORG, can_manage=True, recovery_store=MemoryStore())
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    dialog.new_button.click()
    dialog.sku_input.setText("P-2")
    dialog.name_input.setText("잘못된 금액")
    dialog.price_input.setText("²")
    dialog.save_button.click()
    assert not dialog.busy
    assert "판매가" in dialog.status_label.text()


def test_uncertain_stock_request_survives_dialog_restart(qtbot):
    import httpx

    class UncertainClient(Client):
        payment_recovery_identity = "https://server\nuser"

        def receive_catalog_stock(self, organization_id, product_id, payload):
            self.calls.append(("stock", product_id, payload))
            if len(self.calls) == 1:
                raise httpx.ConnectError("unknown result")
            request = httpx.Request("POST", "https://server/catalog")
            response = httpx.Response(401, request=request)
            raise httpx.HTTPStatusError("login expired", request=request, response=response)

    store = MemoryStore()
    client = UncertainClient()
    first = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=store)
    qtbot.addWidget(first)
    qtbot.waitUntil(lambda: not first.busy)
    first.table.selectRow(0)
    first.stock_reason_input.setText("복구 입고")
    first.stock_button.click()
    qtbot.waitUntil(lambda: not first.busy)
    operation_id = client.calls[0][2]["operation_id"]
    assert store.values

    second = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=store)
    qtbot.addWidget(second)
    qtbot.waitUntil(lambda: not second.busy)
    assert not second.retry_button.isHidden()
    second.retry_button.click()
    qtbot.waitUntil(lambda: not second.busy)
    assert client.calls[-1][2]["operation_id"] == operation_id
    assert store.values


def test_malformed_recovery_blocks_new_inventory_request(qtbot):
    store = MemoryStore()
    client = Client()
    identity = "local-user"
    from hashlib import sha256

    key = f"{sha256(identity.encode('utf-8')).hexdigest()}/{ORG}"
    store.values[key] = "not-json"
    dialog = CatalogManagerDialog(client, ORG, can_manage=True, recovery_store=store)
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert not dialog.save_button.isEnabled()
    assert not dialog.stock_button.isEnabled()
    assert "복구" in dialog.status_label.text()
