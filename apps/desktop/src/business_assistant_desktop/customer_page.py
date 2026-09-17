"""Treatment-focused customer management workspace."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
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
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.icons import set_icon


@dataclass(frozen=True, slots=True)
class Customer:
    id: UUID
    name: str
    email: str | None = None
    phone: str | None = None
    notes: str = ""
    tags: tuple[str, ...] = ()
    status: str = "active"
    last_visit: str | None = None
    treatment_notes: str = ""
    allergies: str = ""
    treatment_date: str | None = None
    service_name: str | None = None
    photos: tuple[str, ...] = ()


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
    """Card grid plus customer information, treatment history and photos."""

    customer_selected = Signal(object)

    def __init__(self, client: CustomerClient, organization_id: UUID) -> None:
        super().__init__()
        self._client, self._organization_id = client, organization_id
        self._customers: list[Customer] = []
        self._selected_id: UUID | None = None
        self.customer_cards: list[QPushButton] = []
        title = QLabel("고객 관리")
        title.setObjectName("page-title")
        subtitle = QLabel("고객별 시술 기록과 사진, 특이사항을 한 화면에서 관리하세요.")
        subtitle.setObjectName("page-subtitle")
        self.search_input = QLineEdit()
        self.search_input.setAccessibleName("고객 검색")
        self.search_input.setPlaceholderText("이름, 연락처, 시술명, 태그로 검색")
        self.filter_combo = QComboBox()
        for label, key in (
            ("전체 고객", "all"),
            ("활성 고객", "active"),
            ("보관 고객", "archived"),
        ):
            self.filter_combo.addItem(label, key)
        self.sort_combo = QComboBox()
        self.sort_combo.addItem("최근 방문순", "recent")
        self.sort_combo.addItem("이름순", "name")
        self.clear_button = QPushButton("초기화")
        self.clear_button.setObjectName("secondary-button")
        set_icon(self.clear_button, "mdi6.filter-variant-remove")
        toolbar = QHBoxLayout()
        toolbar.addWidget(self.search_input, 1)
        toolbar.addWidget(self.filter_combo)
        toolbar.addWidget(self.sort_combo)
        toolbar.addWidget(self.clear_button)
        self.loading_label, self.error_label = QLabel(), QLabel()
        self.error_label.setWordWrap(True)
        self.empty_label = QLabel("검색 조건에 맞는 고객이 없습니다.")
        self.empty_label.setObjectName("status")
        self._cards_host = QWidget()
        self._cards_layout = QGridLayout(self._cards_host)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(12)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setWidget(self._cards_host)
        self.customer_table = QTableWidget(0, 1)
        self.customer_table.setVisible(False)
        self.detail_tabs = QTabWidget()
        self.detail_tabs.addTab(self._build_info_tab(), "고객 정보")
        self.detail_tabs.addTab(self._build_treatment_tab(), "시술 기록")
        self.detail_tabs.addTab(self._build_photo_tab(), "사진")
        self.detail_tabs.setObjectName("customer-detail-tabs")
        detail = QWidget()
        detail_layout = QVBoxLayout(detail)
        detail_layout.setContentsMargins(0, 0, 0, 0)
        detail_layout.addWidget(self.detail_tabs)
        actions = QHBoxLayout()
        self.save_button = QPushButton("고객 추가")
        set_icon(self.save_button, "mdi6.content-save-outline")
        self.delete_button = QPushButton("고객 보관")
        self.delete_button.setObjectName("danger-button")
        set_icon(self.delete_button, "mdi6.archive-outline", "#8B5E4B")
        self.clear_form_button = QPushButton("입력 초기화")
        self.clear_form_button.setObjectName("secondary-button")
        set_icon(self.clear_form_button, "mdi6.broom")
        actions.addWidget(self.save_button)
        actions.addWidget(self.delete_button)
        actions.addWidget(self.clear_form_button)
        detail_layout.addLayout(actions)
        body = QHBoxLayout()
        body.addWidget(scroll, 3)
        body.addWidget(detail, 2)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addLayout(toolbar)
        layout.addWidget(self.loading_label)
        layout.addWidget(self.error_label)
        layout.addWidget(self.empty_label)
        layout.addLayout(body, 1)
        self.search_input.textChanged.connect(self._render)
        self.filter_combo.currentIndexChanged.connect(self._render)
        self.sort_combo.currentIndexChanged.connect(self._render)
        self.customer_table.itemSelectionChanged.connect(self._select_from_table)
        self.clear_button.clicked.connect(self._reset_filters)
        self.save_button.clicked.connect(self._save)
        self.delete_button.clicked.connect(self._delete)
        self.clear_form_button.clicked.connect(self._clear_form)
        self._load()

    def _build_info_tab(self) -> QWidget:
        tab = QWidget()
        form = QFormLayout(tab)
        self.name_input, self.email_input, self.phone_input = QLineEdit(), QLineEdit(), QLineEdit()
        self.tags_input = QLineEdit()
        self.tags_input.setPlaceholderText("VIP, 신규, 정기고객")
        self.status_combo = QComboBox()
        self.status_combo.addItem("활성", "active")
        self.status_combo.addItem("보관", "archived")
        self.notes_input = QTextEdit()
        self.notes_input.setPlaceholderText("고객 응대 메모와 특이사항을 입력하세요")
        self.notes_input.setFixedHeight(80)
        for label, field in (
            ("이름 *", self.name_input),
            ("이메일", self.email_input),
            ("전화번호", self.phone_input),
            ("태그", self.tags_input),
            ("상태", self.status_combo),
            ("메모", self.notes_input),
        ):
            form.addRow(label, field)
        return tab

    def _build_treatment_tab(self) -> QWidget:
        tab = QWidget()
        form = QFormLayout(tab)
        self.treatment_date_input = QLineEdit()
        self.treatment_date_input.setPlaceholderText("예: 2026-09-17")
        self.service_name_input = QLineEdit()
        self.service_name_input.setPlaceholderText("예: 진정 관리, 아쿠아필")
        self.allergies_input = QLineEdit()
        self.allergies_input.setPlaceholderText("알레르기 또는 금기사항")
        self.treatment_notes_input = QTextEdit()
        self.treatment_notes_input.setPlaceholderText("시술 내용, 사용 제품, 고객 반응")
        self.treatment_notes_input.setFixedHeight(100)
        for label, field in (
            ("시술일", self.treatment_date_input),
            ("시술명", self.service_name_input),
            ("주의사항", self.allergies_input),
            ("시술 메모", self.treatment_notes_input),
        ):
            form.addRow(label, field)
        return tab

    def _build_photo_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.photo_gallery = QGridLayout()
        layout.addLayout(self.photo_gallery)
        hint = QLabel("시술 사진은 고객 카드에서 바로 확인할 수 있습니다.")
        hint.setObjectName("page-subtitle")
        layout.addWidget(hint)
        layout.addStretch(1)
        return tab

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
                or query
                in " ".join(
                    (
                        c.name,
                        c.email or "",
                        c.phone or "",
                        getattr(c, "service_name", None) or "",
                        " ".join(getattr(c, "tags", ())),
                    )
                ).lower()
            )
            and (key == "all" or c.status == key)
        ]
        result.sort(
            key=(lambda c: c.name.casefold())
            if self.sort_combo.currentData() == "name"
            else (
                lambda c: (
                    getattr(c, "last_visit", None) or getattr(c, "last_visit_date", None) or ""
                )
            ),
            reverse=self.sort_combo.currentData() != "name",
        )
        return result

    def _render(self) -> None:
        while self._cards_layout.count():
            layout_item = self._cards_layout.takeAt(0)
            if layout_item is not None:
                widget = layout_item.widget()
                if widget is not None:
                    widget.deleteLater()
        self.customer_cards = []
        visible = self._visible_customers()
        self.customer_table.setRowCount(len(visible))
        for row, customer in enumerate(visible):
            table_item = QTableWidgetItem(customer.name)
            table_item.setData(Qt.ItemDataRole.UserRole, customer.id)
            self.customer_table.setItem(row, 0, table_item)
            card = self._make_card(customer)
            self.customer_cards.append(card)
            self._cards_layout.addWidget(card, row // 2, row % 2)
        self.empty_label.setVisible(not visible)

    def _make_card(self, customer: Customer) -> QPushButton:
        card = QPushButton()
        card.setObjectName("treatment-customer-card")
        card.setCursor(Qt.CursorShape.PointingHandCursor)
        card.setAccessibleName(f"고객 카드: {customer.name}")
        card.setMinimumHeight(145)
        tags = "  ".join(f"#{tag}" for tag in customer.tags) or "태그 없음"
        visit = (
            getattr(customer, "last_visit", None)
            or getattr(customer, "last_visit_date", None)
            or getattr(customer, "treatment_date", None)
            or "기록 없음"
        )
        service_name = getattr(customer, "service_name", None) or "최근 시술 기록 없음"
        card.setText(
            f"◉  {customer.name}    ⋮\n{service_name}\n"
            f"시술일  {visit}\n사진 {len(getattr(customer, 'photos', ()))}장   {tags}"
        )
        card.clicked.connect(lambda: self._select_customer(customer))
        return card

    def _select_customer(self, customer: Customer) -> None:
        self._selected_id = customer.id
        self.name_input.setText(customer.name)
        self.email_input.setText(customer.email or "")
        self.phone_input.setText(customer.phone or "")
        self.tags_input.setText(", ".join(customer.tags))
        self.status_combo.setCurrentIndex(max(0, self.status_combo.findData(customer.status)))
        self.notes_input.setPlainText(customer.notes)
        self.treatment_date_input.setText(
            getattr(customer, "treatment_date", None)
            or getattr(customer, "last_visit_date", None)
            or ""
        )
        self.service_name_input.setText(getattr(customer, "service_name", None) or "")
        self.allergies_input.setText(getattr(customer, "allergies", ""))
        self.treatment_notes_input.setPlainText(getattr(customer, "treatment_notes", ""))
        self._render_photos(getattr(customer, "photos", ()))
        self.save_button.setText("고객 정보 저장")
        self.customer_selected.emit(customer)

    def _render_photos(self, photos: tuple[str, ...]) -> None:
        while self.photo_gallery.count():
            layout_item = self.photo_gallery.takeAt(0)
            if layout_item is not None:
                widget = layout_item.widget()
                if widget is not None:
                    widget.deleteLater()
        for index, photo in enumerate(photos):
            label = QLabel(f"시술 사진 {index + 1}\n{photo}")
            label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            label.setMinimumSize(120, 86)
            label.setObjectName("photo-thumbnail")
            self.photo_gallery.addWidget(label, index // 3, index % 3)
        if not photos:
            preview = QLabel()
            preview.setObjectName("photo-thumbnail")
            pixmap = QPixmap(Path(__file__).with_name("assets") / "treatment-samples.png")
            if not pixmap.isNull():
                preview.setPixmap(pixmap.scaled(360, 180, Qt.AspectRatioMode.KeepAspectRatio))
            preview.setToolTip("데모 시술사진 미리보기")
            self.photo_gallery.addWidget(preview, 0, 0, 1, 3)

    def _select_from_table(self) -> None:
        rows = self.customer_table.selectionModel().selectedRows()
        if rows:
            item = self.customer_table.item(rows[0].row(), 0)
            customer = next(
                (
                    c
                    for c in self._customers
                    if item and c.id == item.data(Qt.ItemDataRole.UserRole)
                ),
                None,
            )
            if customer:
                self._select_customer(customer)

    def _save(self) -> None:
        name = self.name_input.text().strip()
        if not name:
            self.error_label.setText("고객 이름을 입력해 주세요.")
            return
        tags = tuple(t.strip() for t in self.tags_input.text().split(",") if t.strip())
        values: dict[str, str | None] = {
            "name": name,
            "email": self.email_input.text().strip() or None,
            "phone": self.phone_input.text().strip() or None,
            "notes": self.notes_input.toPlainText().strip(),
            "tags": ",".join(tags),
            "status": str(self.status_combo.currentData()),
            "treatment_date": self.treatment_date_input.text().strip() or None,
            "service_name": self.service_name_input.text().strip() or None,
            "allergies": self.allergies_input.text().strip() or None,
            "treatment_notes": self.treatment_notes_input.toPlainText().strip(),
        }
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

    def _delete(self) -> None:
        if self._selected_id is None and self.customer_table.currentRow() >= 0:
            self._select_from_table()
        if self._selected_id is None:
            self.error_label.setText("보관할 고객을 선택해 주세요.")
            return
        if (
            QMessageBox.question(self, "고객 보관", "선택한 고객을 보관할까요?")
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            self._client.delete_customer(self._organization_id, self._selected_id)
            self._customers = [c for c in self._customers if c.id != self._selected_id]
            self._clear_form()
            self._render()
        except Exception:
            self.error_label.setText("고객 보관에 실패했습니다.")

    def _reset_filters(self) -> None:
        self.search_input.clear()
        self.filter_combo.setCurrentIndex(0)
        self.sort_combo.setCurrentIndex(0)

    def _clear_form(self) -> None:
        self._selected_id = None
        for field in (
            self.name_input,
            self.email_input,
            self.phone_input,
            self.tags_input,
            self.treatment_date_input,
            self.service_name_input,
            self.allergies_input,
        ):
            field.clear()
        self.status_combo.setCurrentIndex(0)
        self.notes_input.clear()
        self.treatment_notes_input.clear()
        self._render_photos(())
        self.save_button.setText("고객 추가")
