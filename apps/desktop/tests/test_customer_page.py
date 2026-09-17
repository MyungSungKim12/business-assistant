from uuid import UUID, uuid4

from business_assistant_desktop.customer_page import Customer, CustomerPage
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMessageBox

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeClient:
    def __init__(self) -> None:
        self.customers = [Customer(uuid4(), "김고객", "kim@example.com", "010-1", "메모")]

    def list_customers(self, organization_id: UUID) -> list[Customer]:
        return list(self.customers)

    def create_customer(
        self, organization_id: UUID, name: str, email: str | None, phone: str | None, notes: str
    ) -> Customer:
        customer = Customer(uuid4(), name, email, phone, notes)
        self.customers.append(customer)
        return customer

    def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> Customer:
        current = next(item for item in self.customers if item.id == customer_id)
        updated = Customer(
            current.id,
            values.get("name", current.name) or current.name,
            values.get("email", current.email),
            values.get("phone", current.phone),
            values.get("notes", current.notes) or "",
        )
        self.customers[self.customers.index(current)] = updated
        return updated

    def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool:
        self.customers = [item for item in self.customers if item.id != customer_id]
        return True


def test_page_loads_customers_and_filters_by_search(qtbot) -> None:  # type: ignore[no-untyped-def]
    page = CustomerPage(FakeClient(), ORGANIZATION_ID)
    qtbot.addWidget(page)

    assert page.customer_table.rowCount() == 1
    page.search_input.setText("없는 고객")
    assert page.customer_table.rowCount() == 0
    assert "고객이 없습니다" in page.empty_label.text()


def test_page_creates_customer_from_form(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeClient()
    page = CustomerPage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.name_input.setText("새 고객")
    page.email_input.setText("new@example.com")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)

    assert len(client.customers) == 2
    assert page.customer_table.rowCount() == 2


def test_page_updates_selected_customer_and_deletes_it(qtbot, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    client = FakeClient()
    page = CustomerPage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.customer_table.selectRow(0)
    page.name_input.setText("수정 고객")
    qtbot.mouseClick(page.save_button, Qt.MouseButton.LeftButton)
    assert client.customers[0].name == "수정 고객"

    page.customer_table.selectRow(0)
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args: QMessageBox.StandardButton.Yes,
    )
    qtbot.mouseClick(page.delete_button, Qt.MouseButton.LeftButton)
    assert page.customer_table.rowCount() == 0


def test_page_shows_error_when_client_fails(qtbot) -> None:  # type: ignore[no-untyped-def]
    class BrokenClient(FakeClient):
        def list_customers(self, organization_id: UUID) -> list[Customer]:
            raise RuntimeError("offline")

    page = CustomerPage(BrokenClient(), ORGANIZATION_ID)
    qtbot.addWidget(page)
    assert "불러오지 못했습니다" in page.error_label.text()
