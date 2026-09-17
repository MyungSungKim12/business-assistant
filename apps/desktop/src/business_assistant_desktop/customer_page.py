"""Card-based, searchable customer and partner management page."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
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
    tags: tuple[str, ...] = ()
    status: str = "active"


class CustomerClient(Protocol):
    def list_customers(self, organization_id: UUID) -> list[Customer]: ...
    def create_customer(
        self, organization_id: UUID, name: str, email: str | None, phone: str | None, notes: str
    ) -> Customer: ...
    def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> Customer: ...
    def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool: ...


class CustomerPage(QWidget):
    """Display customers as cards with a detail editor and selection signal."""

    customer_selected = Signal(object)

    def __init__(self, client: CustomerClient, organization_id: UUID) -> None:
        super().__init__()
        self._client, self._organization_id = client, organization_id
        self._customers: list[Customer] = []
        self._selected_id: UUID | None = None
        title = QLabel("고객·거래처")
        title.setObjectName("page-title")
        subtitle = QLabel("고객 정보를 한 곳에서 관리하고 최근 활동을 확인하세요.")
        subtitle.setObjectName("page-subtitle")
        self.search_input = QLineEdit()
        self.search_input.setAccessibleName("고객 검색")
        self.search_input.setPlaceholderText("이름, 이메일, 전화번호, 태그 검색")
        self.filter_combo = QComboBox()
        for label, key in (
            ("전체 고객", "all"),
            ("이메일 있는 고객", "email"),
            ("전화번호 있는 고객", "phone"),
        ):
            self.filter_combo.addItem(label, key)
        self.sort_combo = QComboBox()
        self.sort_combo.addItem("이름순", "name")
        self.sort_combo.addItem("최근 등록순", "recent")
        self.clear_button = QPushButton("필터 초기화")
        self.clear_button.setObjectName("secondary-button")
        toolbar = QHBoxLayout()
        toolbar.addWidget(self.search_input, 1)
        toolbar.addWidget(self.filter_combo)
        toolbar.addWidget(self.sort_combo)
        toolbar.addWidget(self.clear_button)
        self.loading_label, self.error_label = QLabel(), QLabel()
        self.error_label.setWordWrap(True)
        self.empty_label = QLabel("조건에 맞는 고객이 없습니다.")
        self.empty_label.setObjectName("status")
        self._cards_host = QWidget()
        self._cards_layout = QGridLayout(self._cards_host)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(12)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setWidget(self._cards_host)
        # Retained for integrations that used the original table query surface.
        self.customer_table = QTableWidget(0, 4)
        self.customer_table.setVisible(False)
        detail = QWidget()
        detail.setObjectName("content-card")
        detail_layout = QVBoxLayout(detail)
        detail_title = QLabel("고객 상세")
        detail_title.setObjectName("section-title")
        detail_layout.addWidget(detail_title)
        form = QFormLayout()
        self.name_input, self.email_input, self.phone_input = QLineEdit(), QLineEdit(), QLineEdit()
        self.tags_input = QLineEdit()
        self.tags_input.setPlaceholderText("예: VIP, 신규, 정기고객 (쉼표로 구분)")
        self.status_combo = QComboBox()
        self.status_combo.addItem("활성", "active")
        self.status_combo.addItem("보관", "archived")
        self.notes_input = QTextEdit()
        self.notes_input.setFixedHeight(72)
        for label, field in (
            ("이름 *", self.name_input),
            ("이메일", self.email_input),
            ("전화번호", self.phone_input),
            ("태그", self.tags_input),
            ("상태", self.status_combo),
            ("메모", self.notes_input),
        ):
            form.addRow(label, field)
        detail_layout.addLayout(form)
        actions = QHBoxLayout()
        self.save_button = QPushButton("고객 추가")
        self.delete_button = QPushButton("선택 고객 삭제")
        self.delete_button.setObjectName("danger-button")
        self.clear_form_button = QPushButton("입력 초기화")
        self.clear_form_button.setObjectName("secondary-button")
        actions.addWidget(self.save_button)
        actions.addWidget(self.delete_button)
        actions.addWidget(self.clear_form_button)
        detail_layout.addLayout(actions)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        for widget in (title, subtitle):
            layout.addWidget(widget)
        layout.addLayout(toolbar)
        layout.addWidget(self.loading_label)
        layout.addWidget(self.error_label)
        layout.addWidget(self.empty_label)
        layout.addWidget(scroll, 1)
        layout.addWidget(detail)
        self.search_input.textChanged.connect(self._render)
        self.filter_combo.currentIndexChanged.connect(self._render)
        self.sort_combo.currentIndexChanged.connect(self._render)
        self.customer_table.itemSelectionChanged.connect(self._select_from_table)
        self.clear_button.clicked.connect(self._reset_filters)
        self.save_button.clicked.connect(self._save)
        self.delete_button.clicked.connect(self._delete)
        self.clear_form_button.clicked.connect(self._clear_form)
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
            self._render()

    def _visible_customers(self) -> list[Customer]:
        query = self.search_input.text().strip().lower()
        key = str(self.filter_combo.currentData() or "all")
        result = [
            c
            for c in self._customers
            if (
                not query
                or any(
                    query in value.lower()
                    for value in (c.name, c.email or "", c.phone or "", " ".join(c.tags))
                )
            )
            and (key == "all" or (key == "email" and c.email) or (key == "phone" and c.phone))
        ]
        result.sort(
            key=lambda c: c.name.casefold(), reverse=self.sort_combo.currentData() != "name"
        )
        return result

    def _render(self) -> None:
        while self._cards_layout.count():
            layout_item = self._cards_layout.takeAt(0)
            widget = layout_item.widget() if layout_item is not None else None
            if widget is not None:
                widget.deleteLater()
        visible = self._visible_customers()
        self.customer_table.setRowCount(len(visible))
        for row, customer in enumerate(visible):
            table_item = QTableWidgetItem(customer.name)
            table_item.setData(Qt.ItemDataRole.UserRole, customer.id)
            self.customer_table.setItem(row, 0, table_item)
        self.empty_label.setVisible(not visible)
        for index, customer in enumerate(visible):
            self._cards_layout.addWidget(self._make_card(customer), index // 3, index % 3)

    def _make_card(self, customer: Customer) -> QWidget:
        card = QPushButton()
        card.setObjectName("customer-card")
        card.setCursor(Qt.CursorShape.PointingHandCursor)
        card.setAccessibleName(f"고객 카드: {customer.name}")
        card.setMinimumHeight(132)
        tags = "  ".join(f"#{tag}" for tag in customer.tags) or "태그 없음"
        card.setText(
            f"{customer.name}\n{customer.email or '이메일 없음'}\n"
            f"{customer.phone or '전화번호 없음'}\n{tags}"
        )
        card.clicked.connect(lambda: self._select_customer(customer))
        return card

    def _select_customer(self, customer: Customer) -> None:
        self._selected_id = customer.id
        self.name_input.setText(customer.name)
        self.email_input.setText(customer.email or "")
        self.phone_input.setText(customer.phone or "")
        self.tags_input.setText(", ".join(customer.tags))
        self.status_combo.setCurrentIndex(self.status_combo.findData(customer.status))
        self.notes_input.setPlainText(customer.notes)
        self.save_button.setText("고객 수정")
        self.customer_selected.emit(customer)

    def _select_from_table(self) -> None:
        rows = self.customer_table.selectionModel().selectedRows()
        if not rows:
            return
        table_item = self.customer_table.item(rows[0].row(), 0)
        if table_item is None:
            return
        customer_id = table_item.data(Qt.ItemDataRole.UserRole)
        customer = next((item for item in self._customers if item.id == customer_id), None)
        if customer is not None:
            self._select_customer(customer)

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
        try:
            if self._selected_id is None:
                self._customers.append(
                    self._client.create_customer(
                        self._organization_id,
                        name,
                        values["email"],
                        values["phone"],
                        values["notes"] or "",
                    )
                )
            else:
                customer = self._client.update_customer(
                    self._organization_id, self._selected_id, values
                )
                self._customers = [customer if c.id == customer.id else c for c in self._customers]
            self._clear_form()
            self._render()
        except Exception:
            self.error_label.setText("고객 저장에 실패했습니다. 입력값을 확인해 주세요.")
        finally:
            self.loading_label.clear()

    def _delete(self) -> None:
        if self._selected_id is None and self.customer_table.currentRow() >= 0:
            self._select_from_table()
        if self._selected_id is None:
            self.error_label.setText("삭제할 고객을 선택해 주세요.")
            return
        if (
            QMessageBox.question(self, "고객 삭제", "선택한 고객을 삭제할까요?")
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            self._client.delete_customer(self._organization_id, self._selected_id)
            self._customers = [c for c in self._customers if c.id != self._selected_id]
            self._clear_form()
            self._render()
        except Exception:
            self.error_label.setText("고객 삭제에 실패했습니다.")

    def _reset_filters(self) -> None:
        self.search_input.clear()
        self.filter_combo.setCurrentIndex(0)
        self.sort_combo.setCurrentIndex(0)

    def _clear_form(self) -> None:
        self._selected_id = None
        for field in (self.name_input, self.email_input, self.phone_input, self.tags_input):
            field.clear()
        self.status_combo.setCurrentIndex(0)
        self.notes_input.clear()
        self.save_button.setText("고객 추가")
