"""Basic customer CRUD page for the desktop application."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True, slots=True)
class Customer:
    id: UUID
    name: str
    email: str | None = None
    phone: str | None = None
    notes: str = ""


class CustomerClient(Protocol):
    def list_customers(self, organization_id: UUID) -> list[Customer]: ...

    def create_customer(
        self,
        organization_id: UUID,
        name: str,
        email: str | None,
        phone: str | None,
        notes: str,
    ) -> Customer: ...

    def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> Customer: ...

    def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool: ...


class CustomerPage(QWidget):
    """Display and edit customers belonging to one organization."""

    def __init__(self, client: CustomerClient, organization_id: UUID) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id
        self._customers: list[Customer] = []
        self._selected_id: UUID | None = None

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("이름, 이메일, 전화번호 검색")
        self.customer_table = QTableWidget(0, 4)
        self.customer_table.setHorizontalHeaderLabels(["이름", "이메일", "전화번호", "메모"])
        self.customer_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.customer_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.empty_label = QLabel("고객이 없습니다.")
        self.error_label = QLabel()
        self.error_label.setWordWrap(True)
        self.loading_label = QLabel()

        self.name_input = QLineEdit()
        self.email_input = QLineEdit()
        self.phone_input = QLineEdit()
        self.notes_input = QTextEdit()
        self.notes_input.setFixedHeight(70)
        self.save_button = QPushButton("고객 추가")
        self.delete_button = QPushButton("선택 고객 삭제")
        self.clear_button = QPushButton("입력 초기화")

        search_row = QHBoxLayout()
        search_row.addWidget(QLabel("검색"))
        search_row.addWidget(self.search_input)
        form = QFormLayout()
        form.addRow("이름 *", self.name_input)
        form.addRow("이메일", self.email_input)
        form.addRow("전화번호", self.phone_input)
        form.addRow("메모", self.notes_input)
        actions = QHBoxLayout()
        actions.addWidget(self.save_button)
        actions.addWidget(self.delete_button)
        actions.addWidget(self.clear_button)
        layout = QVBoxLayout(self)
        layout.addLayout(search_row)
        layout.addWidget(self.loading_label)
        layout.addWidget(self.error_label)
        layout.addWidget(self.empty_label)
        layout.addWidget(self.customer_table)
        layout.addLayout(form)
        layout.addLayout(actions)

        self.search_input.textChanged.connect(self._render_table)
        self.customer_table.itemSelectionChanged.connect(self._select_customer)
        self.save_button.clicked.connect(self._save)
        self.delete_button.clicked.connect(self._delete)
        self.clear_button.clicked.connect(self._clear_form)
        self._load()

    def _load(self) -> None:
        self.loading_label.setText("고객을 불러오는 중...")
        self.error_label.clear()
        try:
            self._customers = self._client.list_customers(self._organization_id)
        except Exception:
            self._customers = []
            self.error_label.setText("고객을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.")
        finally:
            self.loading_label.clear()
            self._render_table()

    def _render_table(self) -> None:
        query = self.search_input.text().strip().lower()
        visible = [
            customer
            for customer in self._customers
            if not query
            or query in customer.name.lower()
            or query in (customer.email or "").lower()
            or query in (customer.phone or "").lower()
        ]
        self.customer_table.setRowCount(len(visible))
        for row, customer in enumerate(visible):
            for column, value in enumerate(
                (customer.name, customer.email or "", customer.phone or "", customer.notes)
            ):
                item = QTableWidgetItem(value)
                item.setData(Qt.ItemDataRole.UserRole, customer.id)
                self.customer_table.setItem(row, column, item)
        self.empty_label.setVisible(not visible)

    def _select_customer(self) -> None:
        rows = self.customer_table.selectionModel().selectedRows()
        if not rows:
            return
        item = self.customer_table.item(rows[0].row(), 0)
        if item is None:
            return
        customer_id = item.data(Qt.ItemDataRole.UserRole)
        customer = next((item for item in self._customers if item.id == customer_id), None)
        if customer is None:
            return
        self._selected_id = customer.id
        self.name_input.setText(customer.name)
        self.email_input.setText(customer.email or "")
        self.phone_input.setText(customer.phone or "")
        self.notes_input.setPlainText(customer.notes)
        self.save_button.setText("고객 수정")

    def _save(self) -> None:
        name = self.name_input.text().strip()
        if not name:
            self.error_label.setText("고객 이름을 입력해 주세요.")
            return
        values = {
            "name": name,
            "email": self.email_input.text().strip() or None,
            "phone": self.phone_input.text().strip() or None,
            "notes": self.notes_input.toPlainText().strip(),
        }
        self.loading_label.setText("저장 중...")
        self.error_label.clear()
        try:
            if self._selected_id is None:
                customer = self._client.create_customer(
                    self._organization_id,
                    name=values["name"] or "",
                    email=values["email"],
                    phone=values["phone"],
                    notes=values["notes"] or "",
                )
                self._customers.append(customer)
            else:
                customer = self._client.update_customer(
                    self._organization_id, self._selected_id, values
                )
                self._customers = [
                    customer if item.id == customer.id else item for item in self._customers
                ]
            self._clear_form()
            self._render_table()
        except Exception:
            self.error_label.setText("고객 저장에 실패했습니다. 입력값을 확인해 주세요.")
        finally:
            self.loading_label.clear()

    def _delete(self) -> None:
        if self._selected_id is None:
            self.error_label.setText("삭제할 고객을 선택해 주세요.")
            return
        answer = QMessageBox.question(self, "고객 삭제", "선택한 고객을 삭제할까요?")
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.loading_label.setText("삭제 중...")
        try:
            self._client.delete_customer(self._organization_id, self._selected_id)
            self._customers = [item for item in self._customers if item.id != self._selected_id]
            self._clear_form()
            self._render_table()
        except Exception:
            self.error_label.setText("고객 삭제에 실패했습니다.")
        finally:
            self.loading_label.clear()

    def _clear_form(self) -> None:
        self._selected_id = None
        self.name_input.clear()
        self.email_input.clear()
        self.phone_input.clear()
        self.notes_input.clear()
        self.save_button.setText("고객 추가")
        self.customer_table.clearSelection()
