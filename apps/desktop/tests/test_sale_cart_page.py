from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from business_assistant_desktop.sale_cart_page import SaleCartWorkspace
from PySide6.QtCore import Qt

ORG = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER = UUID("22222222-2222-2222-2222-222222222222")
VISIT = UUID("33333333-3333-3333-3333-333333333333")
CART = UUID("44444444-4444-4444-4444-444444444444")
DRAFT = UUID("55555555-5555-5555-5555-555555555555")
LINE = UUID("66666666-6666-6666-6666-666666666666")


def bundle(version=1, lines=None):
    rows = lines or []
    total = sum(
        (Decimal(str(row.get("line_total", 0))) for row in rows if row.get("status") == "active"),
        Decimal("0"),
    )
    return {
        "visit": {"id": str(VISIT), "customer_id": str(CUSTOMER), "status": "open", "version": 1},
        "cart": {
            "id": str(CART),
            "version": version,
            "status": "draft",
            "subtotal": str(total),
            "discount_total": "0.00",
            "total_amount": str(total),
        },
        "lines": rows,
    }


class Client:
    def __init__(self):
        self.visits = [
            {
                "id": str(VISIT),
                "customer_id": str(CUSTOMER),
                "status": "open",
                "version": 1,
                "opened_at": "2030-01-01T09:00:00Z",
            }
        ]
        self.drafts = [
            {
                "id": str(DRAFT),
                "customer_id": str(CUSTOMER),
                "description": "피부 관리",
                "amount": "12000.00",
                "source_snapshot": {"customer": {"name": "김고객"}},
            }
        ]
        self.cart = bundle()
        self.operations = []

    def list_customers(self, organization_id):
        return [SimpleNamespace(id=CUSTOMER, name="김고객", phone="010-1234-5678")]

    def list_customer_visits(self, organization_id, customer_id=None, status=None):
        return self.visits

    def list_treatment_sale_drafts(self, organization_id):
        return self.drafts

    def get_sale_cart(self, organization_id, visit_id):
        return self.cart

    def create_customer_visit(self, organization_id, customer_id, operation_id):
        self.operations.append(("create", operation_id))
        self.cart = bundle()
        return self.cart

    def add_treatment_draft_to_cart(
        self, organization_id, visit_id, draft_id, version, operation_id
    ):
        self.operations.append(("add", operation_id))
        self.cart = bundle(
            2,
            [
                {
                    "id": str(LINE),
                    "source_id": str(DRAFT),
                    "description_snapshot": "피부 관리",
                    "quantity": 1,
                    "unit_price": "12000.00",
                    "line_total": "12000.00",
                    "staff_name_snapshot": "담당",
                    "status": "active",
                    "removal_reason": "",
                }
            ],
        )
        return self.cart

    def update_sale_cart_line(self, *args):
        values = args[-1]
        line = dict(self.cart["lines"][0])
        line.update(
            quantity=values["quantity"],
            unit_price=values["unit_price"],
            staff_name_snapshot=values["staff_name"],
        )
        line["line_total"] = str(int(values["quantity"]) * int(values["unit_price"]))
        self.cart = bundle(int(self.cart["cart"]["version"]) + 1, [line])
        return self.cart

    def remove_sale_cart_line(self, *args):
        return self.cart

    def restore_sale_cart_line(self, *args):
        return self.cart

    def review_sale_cart(self, organization_id, visit_id, version, operation_id, ready):
        self.cart = {
            **self.cart,
            "cart": {**self.cart["cart"], "status": "ready", "version": version + 1},
        }
        return self.cart


def test_workspace_loads_three_columns_and_adds_draft(qtbot):
    client = Client()
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)

    assert page.customer_list.count() == 1
    assert page.visit_list.count() == 1
    assert page.draft_list.count() == 1
    page.draft_list.setCurrentRow(0)
    qtbot.mouseClick(page.add_draft_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: not page.busy)

    assert page.line_table.rowCount() == 1
    assert "12,000" in page.total_label.text()
    assert client.operations[0][0] == "add"

    page.line_table.selectRow(0)
    page.quantity_input.setValue(2)
    page.price_input.setText("500")
    page.staff_input.setText("새 담당")
    qtbot.mouseClick(page.save_line_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: not page.busy)
    assert page.line_table.item(0, 1).text() == "2"
    assert page.line_table.item(0, 3).text() == "새 담당"

    removed = dict(client.cart["lines"][0], status="removed", removal_reason="고객 요청")
    page._render_bundle(bundle(4, [removed]))
    assert page.draft_list.count() == 1


def test_read_only_member_cannot_mutate(qtbot):
    page = SaleCartWorkspace(Client(), ORG, can_manage=False)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    assert not page.new_visit_button.isEnabled()
    assert not page.add_draft_button.isEnabled()
    assert not page.review_button.isEnabled()
    assert not page.cancel_visit_button.isEnabled()


def test_review_requires_a_nonempty_cart(qtbot):
    page = SaleCartWorkspace(Client(), ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    assert not page.review_button.isEnabled()


def test_partial_initial_failure_keeps_successful_customer_and_visit_columns(qtbot):
    class PartialClient(Client):
        def list_treatment_sale_drafts(self, organization_id):
            raise RuntimeError("draft service offline")

    page = SaleCartWorkspace(PartialClient(), ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    assert page.customer_list.count() == 1
    assert page.visit_list.count() == 1
    assert page.draft_list.count() == 0
    assert "일부" in page.status_label.text()


def test_unsaved_editor_blocks_close_and_customer_switch(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    client = Client()
    client.add_treatment_draft_to_cart(ORG, VISIT, DRAFT, 1, LINE)
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.line_table.selectRow(0)
    page.price_input.setText("900")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Cancel)
    assert not page.confirm_leave()
    page.customers.append(SimpleNamespace(id=LINE, name="다른 고객", phone=""))
    page.customer_list.addItem("다른 고객")
    page.customer_list.setCurrentRow(1)
    assert page.customer_list.currentRow() == 0
    assert page.price_input.text() == "900"


def test_busy_locks_context_selection(qtbot):
    page = SaleCartWorkspace(Client(), ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.busy = True
    page._controls()
    assert not page.customer_list.isEnabled()
    assert not page.visit_list.isEnabled()
    assert not page.line_table.isEnabled()
    page.busy = False


def test_customer_without_visit_clears_previous_cart(qtbot):
    client = Client()
    client.add_treatment_draft_to_cart(ORG, VISIT, DRAFT, 1, LINE)
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.customers.append(SimpleNamespace(id=LINE, name="다른 고객", phone=""))
    page.customer_list.addItem("다른 고객")
    page.customer_list.setCurrentRow(1)
    assert page.bundle is None
    assert page.line_table.rowCount() == 0
    assert page.total_label.text() == "청구 예정 0원"


def test_unsaved_editor_blocks_line_visit_and_accept(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    client = Client()
    client.add_treatment_draft_to_cart(ORG, VISIT, DRAFT, 1, LINE)
    client.cart["lines"].append(dict(client.cart["lines"][0], id=str(DRAFT)))
    client.visits.append(dict(client.visits[0], id=str(LINE)))
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.show()
    page.line_table.selectRow(0)
    page.price_input.setText("900")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Cancel)
    page.line_table.selectRow(1)
    assert page.line_table.currentRow() == 0
    assert page.price_input.text() == "900"
    page.visit_list.setCurrentRow(1)
    assert page.visit_list.currentRow() == 0
    page.accept()
    assert page.isVisible()
    page._review()
    assert not page.busy
    assert client.cart["cart"]["status"] == "draft"
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)
    page.line_table.selectRow(1)
    assert page.line_table.currentRow() == 1
    assert page.price_input.text() == "12000.00"


def test_uncertain_request_keeps_editor_and_locks_navigation(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)

    class FailingClient(Client):
        def update_sale_cart_line(self, *args):
            self.operations.append(("update", args[-2]))
            raise TimeoutError("response lost")

    client = FailingClient()
    client.add_treatment_draft_to_cart(ORG, VISIT, DRAFT, 1, LINE)
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.line_table.selectRow(0)
    page.price_input.setText("900")
    page._save_line()
    qtbot.waitUntil(lambda: not page.busy)
    assert page.price_input.text() == "900"
    assert not page.customer_list.isEnabled()
    page._retry_pending()
    qtbot.waitUntil(lambda: not page.busy)
    assert client.operations[-1] == client.operations[-2]


def test_new_visit_does_not_fetch_cart_again(qtbot):
    class CountingClient(Client):
        reads = 0

        def get_sale_cart(self, *args):
            self.reads += 1
            return self.cart

    client = CountingClient()
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    before = client.reads
    page._create_visit()
    qtbot.waitUntil(lambda: not page.busy)
    assert client.reads == before
    assert page.bundle == client.cart


def test_rejected_input_can_be_corrected_without_replaying_bad_request(qtbot):
    import httpx

    page = SaleCartWorkspace(Client(), ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page._retry = ("update", lambda: None)
    response = httpx.Response(422, request=httpx.Request("PATCH", "https://example.test"))
    error = httpx.HTTPStatusError("invalid", request=response.request, response=response)
    page._finished(("update", None, error))
    assert page._retry is None
    assert page.customer_list.isEnabled()
    assert "입력값" in page.status_label.text()


def test_void_cart_disables_mutation_but_allows_new_visit(qtbot):
    page = SaleCartWorkspace(Client(), ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    canceled = bundle()
    canceled["cart"]["status"] = "void"
    page._render_bundle(canceled)
    page._controls()
    page.draft_list.setCurrentRow(0)
    assert not page.add_draft_button.isEnabled()
    assert not page.cancel_visit_button.isEnabled()
    assert page.new_visit_button.isEnabled()


def test_reload_cancel_preserves_editor(qtbot, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    client = Client()
    client.add_treatment_draft_to_cart(ORG, VISIT, DRAFT, 1, LINE)
    page = SaleCartWorkspace(client, ORG, can_manage=True)
    qtbot.addWidget(page)
    qtbot.waitUntil(lambda: not page.busy)
    page.line_table.selectRow(0)
    page.price_input.setText("900")
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Cancel)
    page.reload()
    assert not page.busy
    assert page.price_input.text() == "900"
    monkeypatch.setattr(QMessageBox, "question", lambda *a: QMessageBox.StandardButton.Discard)


def test_money_display_does_not_round_away_fraction_or_mask_invalid_value():
    from business_assistant_desktop.sale_cart_page import _money

    assert _money("100.25") == "100.25원"
    assert _money("1000.00") == "1,000원"
    assert _money("NaN") == "금액 확인 필요"
