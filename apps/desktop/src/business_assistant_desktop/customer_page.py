"""Treatment-focused customer management workspace."""

from collections.abc import Callable
from pathlib import Path
from threading import Event
from typing import Any, Protocol
from uuid import UUID

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtGui import QPixmap, QResizeEvent
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.api_client import Customer, CustomerActivity, CustomerPhoto
from business_assistant_desktop.customer_activity_panel import CustomerActivityPanel
from business_assistant_desktop.customer_form import CustomerForm
from business_assistant_desktop.customer_widgets import CUSTOMER_STYLE, PhotoTile, label
from business_assistant_desktop.icons import icon, set_icon
from business_assistant_desktop.upload_transfer import UploadCancelled


class CustomerClient(Protocol):
    def list_customers(self, organization_id: UUID) -> list[Customer]: ...
    def create_customer_record(
        self, organization_id: UUID, values: dict[str, object]
    ) -> Customer: ...
    def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> Customer: ...
    def list_customer_activities(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[CustomerActivity]: ...
    def create_customer_activity(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> CustomerActivity: ...
    def list_customer_photos(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[CustomerPhoto]: ...
    def upload_customer_photo(
        self,
        organization_id: UUID,
        customer_id: UUID,
        original_name: str,
        content: bytes,
        content_type: str,
        caption: str = "",
        **transfer_options: Any,
    ) -> CustomerPhoto: ...
    def download_customer_photo(
        self, organization_id: UUID, customer_id: UUID, photo_id: UUID
    ) -> bytes: ...


class _PhotoSignals(QObject):
    finished = Signal(object)
    progress = Signal(object)


class _PhotoRequest(QRunnable):
    def __init__(self, generation: int, operation: Callable[[], object]) -> None:
        super().__init__()
        self.generation = generation
        self.operation = operation
        self.signals = _PhotoSignals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((self, result, error))


class CustomerPage(QWidget):
    """Card grid plus customer information, treatment history and photos."""

    customer_selected = Signal(object)
    treatment_requested = Signal(object)

    def __init__(
        self,
        client: CustomerClient,
        organization_id: UUID,
        *,
        can_manage: bool = True,
        demo_photos: bool = False,
    ) -> None:
        super().__init__()
        self._client, self._organization_id = client, organization_id
        self._can_manage, self._demo_photos = can_manage, demo_photos
        self._saving = False
        self._customers: list[Customer] = []
        self._selected_id: UUID | None = None
        self.customer_cards: list[QPushButton] = []
        self._card_columns = 3
        self.setObjectName("customer-workspace")
        self.setStyleSheet(CUSTOMER_STYLE)
        header = QHBoxLayout()
        titles = QVBoxLayout()
        titles.setSpacing(5)
        titles.addWidget(label("고객관리", "workspace-title"))
        titles.addWidget(label("고객의 방문과 상담을 한눈에", "muted"))
        header.addLayout(titles)
        header.addSpacing(10)
        header.addStretch()
        if not can_manage:
            header.addWidget(label("조회 전용 · 수정은 관리자 권한이 필요합니다", "muted"))
        self.clear_form_button = QPushButton("고객 등록")
        self.clear_form_button.setProperty("role", "primary")
        set_icon(self.clear_form_button, "mdi6.plus", "#ffffff")
        header.addWidget(self.clear_form_button)

        self.search_input = QLineEdit()
        self.search_input.setAccessibleName("고객 검색")
        self.search_input.setPlaceholderText("고객명 또는 연락처 검색")
        self.search_input.addAction(
            icon("mdi6.magnify", "#8c8783"), QLineEdit.ActionPosition.LeadingPosition
        )
        self.filter_combo = QComboBox()
        for text, value in (
            ("활성 고객", "active"),
            ("전체 고객", "all"),
            ("보관 고객", "archived"),
        ):
            self.filter_combo.addItem(text, value)
        self.sort_combo = QComboBox()
        self.sort_combo.addItem("최근 방문", "recent")
        self.sort_combo.addItem("이름순", "name")
        self.clear_button = QPushButton()
        set_icon(self.clear_button, "mdi6.filter-remove-outline")
        self.clear_button.setToolTip("검색 조건 초기화")
        self.clear_button.setAccessibleName("검색 조건 초기화")
        toolbar = QHBoxLayout()
        toolbar.setSpacing(8)
        toolbar.addWidget(self.sort_combo, 1)
        toolbar.addWidget(self.filter_combo, 1)
        toolbar.addWidget(self.clear_button)
        self.reload_button = QPushButton()
        set_icon(self.reload_button, "mdi6.refresh")
        self.reload_button.setToolTip("고객 목록 새로고침")
        self.reload_button.setAccessibleName("고객 목록 새로고침")
        toolbar.addWidget(self.reload_button)
        self.result_count = label("", "muted")
        self.loading_label, self.error_label = QLabel(), QLabel()
        self.error_label.setObjectName("error")
        self.error_label.setWordWrap(True)
        self.empty_label = label("검색 조건에 맞는 고객이 없습니다.", "muted")
        self._cards_host = QWidget()
        self._cards_layout = QGridLayout(self._cards_host)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(10)
        self._cards_layout.setAlignment(Qt.AlignmentFlag.AlignTop)
        for column in range(3):
            self._cards_layout.setColumnStretch(column, 1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setWidget(self._cards_host)
        scroll.setMinimumHeight(150)
        self.customer_table = QTableWidget(0, 1)
        self.customer_table.setVisible(False)
        grid_panel = QWidget()
        grid_panel.setObjectName("customer-grid")
        grid_layout = QVBoxLayout(grid_panel)
        grid_layout.setContentsMargins(14, 14, 14, 14)
        grid_layout.addWidget(self.search_input)
        grid_layout.addLayout(toolbar)
        grid_layout.addWidget(self.result_count)
        grid_layout.addWidget(self.empty_label)
        grid_layout.addWidget(scroll, 1)

        self.info_panel = self._build_info_tab()
        self.info_panel.setObjectName("customer-form")
        self.info_panel.setMinimumHeight(310)
        self.save_button = QPushButton("정보 저장")
        self.save_button.setObjectName("save-customer")
        set_icon(self.save_button, "mdi6.content-save-outline", "#ffffff")
        info_container = QWidget()
        info_container.setObjectName("info-panel")
        info_layout = QVBoxLayout(info_container)
        info_layout.setContentsMargins(10, 8, 10, 10)
        info_scroll = QScrollArea()
        info_scroll.setWidgetResizable(True)
        info_scroll.setWidget(self.info_panel)
        info_layout.addWidget(info_scroll, 1)
        info_layout.addWidget(self.save_button)
        left = QVBoxLayout()
        left.setSpacing(10)
        left.addWidget(grid_panel, 2)
        left.addWidget(info_container, 2)

        detail = QWidget()
        detail.setObjectName("detail-panel")
        detail_layout = QVBoxLayout(detail)
        detail_layout.setContentsMargins(16, 16, 16, 14)
        detail_layout.setSpacing(12)
        profile = QHBoxLayout()
        self.avatar = PhotoTile(round_avatar=True)
        self.avatar.setFixedSize(62, 62)
        profile.addWidget(self.avatar)
        profile_text = QVBoxLayout()
        self.profile_name = label("고객을 선택하세요", "profile-name")
        self.profile_contact = label("연락처 · 최근 방문", "muted")
        self.profile_tags = label("", "muted", True)
        profile_text.addWidget(self.profile_name)
        profile_text.addWidget(self.profile_contact)
        profile_text.addWidget(self.profile_tags)
        profile.addLayout(profile_text, 1)
        self.delete_button = QPushButton()
        set_icon(self.delete_button, "mdi6.archive-outline")
        self.delete_button.setToolTip("고객 보관")
        self.delete_button.setAccessibleName("고객 보관")
        profile.addWidget(self.delete_button, 0, Qt.AlignmentFlag.AlignTop)
        detail_layout.addLayout(profile)
        self.detail_tabs = QTabWidget()
        self.detail_tabs.setObjectName("customer-detail-tabs")
        self.activity_panel = CustomerActivityPanel(client, organization_id, can_manage=can_manage)
        self.detail_tabs.addTab(self.activity_panel, "상담 이력")
        self.detail_tabs.addTab(self._build_photo_tab(), "사진")
        self.add_photo_button.setEnabled(can_manage)
        memo = QWidget()
        memo_layout = QVBoxLayout(memo)
        memo_layout.addWidget(label("고객 상담 메모", "section-title"))
        self.memo_preview = label("고객을 선택하면 메모가 표시됩니다.", "muted", True)
        memo_layout.addWidget(self.memo_preview)
        memo_layout.addStretch()
        self.detail_tabs.addTab(memo, "메모")
        detail_layout.addWidget(self.detail_tabs, 1)
        photo_heading = QHBoxLayout()
        photo_heading.addWidget(label("시술사진", "section-title"))
        self.photo_caption = label("등록된 사진 없음", "muted")
        photo_heading.addWidget(self.photo_caption, 1)
        self.previous_photo = QPushButton("‹")
        self.next_photo = QPushButton("›")
        for button in (self.previous_photo, self.next_photo):
            button.setFixedWidth(30)
            button.setObjectName("photo-navigation")
            photo_heading.addWidget(button)
        self.previous_photo.clicked.connect(lambda: self._step_photo(-1))
        self.next_photo.clicked.connect(lambda: self._step_photo(1))
        detail_layout.addLayout(photo_heading)
        self.large_photo = PhotoTile()
        self.large_photo.setMinimumHeight(112)
        detail_layout.addWidget(self.large_photo, 1)
        self.preview_strip = QHBoxLayout()
        detail_layout.addLayout(self.preview_strip)
        detail_layout.addWidget(
            label(
                "데모용 샘플 이미지" if demo_photos else "등록된 고객 사진만 표시됩니다.", "muted"
            )
        )
        actions = QHBoxLayout()
        self.record_button = QPushButton("상담 이력 보기")
        self.photo_button = QPushButton("사진 보기")
        set_icon(self.record_button, "mdi6.clipboard-text-outline")
        set_icon(self.photo_button, "mdi6.image-outline")
        self.record_button.clicked.connect(lambda: self.detail_tabs.setCurrentIndex(0))
        self.photo_button.clicked.connect(lambda: self.detail_tabs.setCurrentIndex(1))
        actions.addWidget(self.record_button)
        actions.addWidget(self.photo_button)
        detail_layout.addLayout(actions)
        self.treatment_button = QPushButton("시술관리 열기")
        set_icon(self.treatment_button, "mdi6.clipboard-text-outline")
        self.treatment_button.clicked.connect(
            lambda: self.treatment_requested.emit(self._selected_id)
        )
        detail_layout.addWidget(self.treatment_button)
        body = QHBoxLayout()
        body.setSpacing(12)
        body.addLayout(left, 65)
        body.addWidget(detail, 35)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        layout.addLayout(header)
        layout.addWidget(self.loading_label)
        layout.addWidget(self.error_label)
        self.loading_label.hide()
        self.error_label.hide()
        layout.addLayout(body, 1)
        self._photos: tuple[str, ...] = ()
        self._photo_pixmaps: tuple[QPixmap, ...] = ()
        self._photo_generation = 0
        self._photo_workers: set[_PhotoRequest] = set()
        self._photo_loading = False
        self._upload_cancel = Event()
        self._photo_uploading = False
        self._photo_upload_worker: _PhotoRequest | None = None
        self._pending_photo: tuple[UUID, str, bytes, str, str] | None = None
        self._photo_cache: dict[UUID, tuple[list[CustomerPhoto], list[bytes]]] = {}
        self._photo_index = 0
        self._render_photos(())
        self.search_input.textChanged.connect(self._render)
        self.filter_combo.currentIndexChanged.connect(self._render)
        self.sort_combo.currentIndexChanged.connect(self._render)
        self.customer_table.itemSelectionChanged.connect(self._select_from_table)
        self.clear_button.clicked.connect(self._reset_filters)
        self.save_button.clicked.connect(self._save)
        self.delete_button.clicked.connect(self._archive_customer)
        self.clear_form_button.clicked.connect(self._new_customer)
        self.reload_button.clicked.connect(self._reload)
        self.activity_panel.set_customer(None)
        self.info_panel.changed.connect(self._update_form_state)
        self.activity_panel.dirty_changed.connect(self._update_form_state)
        self.info_panel.set_readonly(not can_manage)
        self.clear_form_button.setEnabled(can_manage)
        self._load()
        self._update_form_state()

    def _build_info_tab(self) -> CustomerForm:
        form = CustomerForm()
        self.name_input = form.fields["name"]
        self.email_input = form.fields["email"]
        self.phone_input = form.fields["phone"]
        self.tags_input = form.fields["tags"]
        self.birth_input = form.fields["birth_date"]
        self.skin_input = form.fields["skin_type"]
        self.last_visit_input = form.fields["last_visit_date"]
        self.next_visit_input = form.fields["next_visit_date"]
        self.allergies_input = form.fields["allergies"]
        self.concerns_input = form.fields["concerns"]
        self.status_combo, self.notes_input = form.status, form.notes
        return form

    def _build_photo_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.photo_gallery = QGridLayout()
        layout.addLayout(self.photo_gallery)
        self.add_photo_button = QPushButton("사진 추가")
        set_icon(self.add_photo_button, "mdi6.image-plus-outline")
        self.add_photo_button.clicked.connect(self._add_photo)
        layout.addWidget(self.add_photo_button, 0, Qt.AlignmentFlag.AlignLeft)
        self.upload_status = label("", "muted", True)
        self.upload_progress = QProgressBar()
        self.upload_progress.setRange(0, 100)
        self.upload_progress.hide()
        self.cancel_upload_button = QPushButton("업로드 취소")
        self.cancel_upload_button.hide()
        self.cancel_upload_button.clicked.connect(self._cancel_photo_upload)
        self.reload_photos_button = QPushButton("사진 새로고침")
        self.reload_photos_button.clicked.connect(self._retry_photo_load)
        layout.addWidget(self.reload_photos_button)
        layout.addWidget(self.upload_status)
        layout.addWidget(self.upload_progress)
        layout.addWidget(self.cancel_upload_button)
        self.photo_retry_button = QPushButton("업로드 다시 시도")
        self.photo_retry_button.setVisible(False)
        self.photo_retry_button.clicked.connect(self._retry_photo_upload)
        layout.addWidget(self.photo_retry_button, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addStretch()
        return tab

    def _load(self) -> None:
        self.loading_label.setText("고객을 불러오는 중...")
        self.error_label.clear()
        self.error_label.hide()
        try:
            self._customers = self._client.list_customers(self._organization_id)
        except Exception:
            self._show_error("고객을 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.")
        finally:
            self.loading_label.clear()
            self._render()

    def _reload(self) -> None:
        if self.confirm_leave():
            selected = self._selected_id
            self._load()
            current = next((c for c in self._customers if c.id == selected), None)
            if current:
                self._apply_customer(current)
            else:
                self._clear_form()

    def _visible_customers(self) -> list[Customer]:
        query = self.search_input.text().strip().casefold()
        digits = "".join(c for c in query if c.isdigit())
        phone_query = bool(digits) and all(c.isdigit() or c in "-+ ()" for c in query)
        key = str(self.filter_combo.currentData() or "all")
        result = [
            c
            for c in self._customers
            if (
                not query
                or query
                in " ".join((c.name, c.email or "", c.phone or "", *c.tags, *c.concerns)).casefold()
                or (phone_query and digits in "".join(ch for ch in c.phone or "" if ch.isdigit()))
            )
            and (key == "all" or c.status == key)
        ]
        result.sort(
            key=(lambda c: c.name.casefold())
            if self.sort_combo.currentData() == "name"
            else (lambda c: c.last_visit_date or ""),
            reverse=self.sort_combo.currentData() != "name",
        )
        return result

    def _render(self) -> None:
        while self._cards_layout.count():
            layout_item = self._cards_layout.takeAt(0)
            if layout_item is not None:
                widget = layout_item.widget()
                if widget is not None:
                    widget.hide()
                    widget.deleteLater()
        self.customer_cards = []
        visible = self._visible_customers()
        self.customer_table.blockSignals(True)
        self.customer_table.setRowCount(len(visible))
        for row, customer in enumerate(visible):
            table_item = QTableWidgetItem(customer.name)
            table_item.setData(Qt.ItemDataRole.UserRole, customer.id)
            self.customer_table.setItem(row, 0, table_item)
            card = self._make_card(customer)
            self.customer_cards.append(card)
            self._cards_layout.addWidget(card, row // self._card_columns, row % self._card_columns)
        self.customer_table.blockSignals(False)
        self.empty_label.setVisible(not visible)
        archived = sum(c.status == "archived" for c in self._customers)
        self.result_count.setText(
            f"검색 {len(visible)}명  ·  전체 {len(self._customers)}명  ·  "
            f"활성 {len(self._customers) - archived}명  ·  보관 {archived}명"
        )

    def resizeEvent(self, event: QResizeEvent) -> None:
        super().resizeEvent(event)
        columns = 2 if self.width() < 1050 else 3
        if columns == self._card_columns:
            return
        self._card_columns = columns
        for card in self.customer_cards:
            self._cards_layout.removeWidget(card)
        for column in range(3):
            self._cards_layout.setColumnStretch(column, 1 if column < columns else 0)
        for index, card in enumerate(self.customer_cards):
            self._cards_layout.addWidget(card, index // columns, index % columns)

    def _make_card(self, customer: Customer) -> QPushButton:
        card = QPushButton()
        card.setObjectName("treatment-customer-card")
        card.setProperty("customer_id", str(customer.id))
        card.setProperty("selected", customer.id == self._selected_id)
        card.setCursor(Qt.CursorShape.PointingHandCursor)
        card.setAccessibleName(f"고객 카드: {customer.name}")
        card.setMinimumHeight(150 if not self._demo_photos else 175)
        card.setMinimumWidth(150)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(7)
        heading = QHBoxLayout()
        avatar = PhotoTile(round_avatar=True)
        avatar.setFixedSize(38, 38)
        heading.addWidget(avatar)
        names = QVBoxLayout()
        names.setSpacing(2)
        names.addWidget(label(customer.name, "card-name"))
        visit = (
            getattr(customer, "last_visit", None)
            or getattr(customer, "last_visit_date", None)
            or "기록 없음"
        )
        visit_label = label(str(visit), "card-visit")
        visit_label.setToolTip(f"최근 방문 {visit}")
        names.addWidget(visit_label)
        heading.addLayout(names, 1)
        layout.addLayout(heading)
        images = QHBoxLayout()
        images.setSpacing(3)
        photos: tuple[str, ...] = ()
        for index in range(3 if self._demo_photos else 0):
            tile = PhotoTile(
                photos[index] if index < len(photos) else "",
                sample_index=(0, 2, 1)[index] if self._demo_photos else -1,
            )
            tile.setFixedHeight(52)
            images.addWidget(tile, 1)
        layout.addLayout(images)
        if not self._demo_photos:
            layout.addWidget(label(customer.phone or "연락처 미등록", "card-contact"))
            layout.addSpacing(4)
        tags = QHBoxLayout()
        tags.setSpacing(4)
        for tag in customer.tags[:2]:
            tag_label = label(tag, "tag")
            tag_label.setToolTip(tag)
            tags.addWidget(tag_label)
        if len(customer.tags) > 2:
            more_tags = label(f"+{len(customer.tags) - 2}", "tag")
            more_tags.setToolTip(", ".join(customer.tags[2:]))
            tags.addWidget(more_tags)
        if not customer.tags:
            tags.addWidget(label("등록된 태그 없음", "muted"))
        tags.addStretch()
        layout.addLayout(tags)
        layout.addWidget(
            label(
                "주요 고민" + ("  ·  샘플 사진" if not photos and self._demo_photos else ""),
                "muted",
            )
        )
        notes = label(
            ", ".join(customer.concerns) or customer.notes or "등록된 상담 메모가 없습니다.",
            "muted",
            True,
        )
        notes.setMaximumHeight(30)
        layout.addWidget(notes)
        for child in card.findChildren(QWidget):
            child.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        card.clicked.connect(lambda: self._select_customer(customer))
        return card

    def _select_customer(self, customer: Customer) -> None:
        if customer.id == self._selected_id:
            return
        if self.confirm_leave():
            self._apply_customer(customer)

    def _apply_customer(self, customer: Customer) -> None:
        self._selected_id = customer.id
        self.info_panel.populate(customer)
        self.profile_name.setText(customer.name)
        self.profile_contact.setText(customer.phone or "연락처 미등록")
        self.profile_tags.setText("  ·  ".join(customer.tags))
        self.memo_preview.setText(customer.notes or "등록된 메모가 없습니다.")
        self._photo_pixmaps = ()
        self._render_photos(())
        if self._selected_id is not None and hasattr(self._client, "list_customer_photos"):
            cached = self._photo_cache.get(self._selected_id)
            if cached is None:
                self._load_customer_photos(self._selected_id)
            else:
                self._display_photo_data(*cached)
        self.detail_tabs.setCurrentIndex(0)
        self.activity_panel.set_customer(customer.id)
        self.delete_button.setToolTip("고객 복원" if customer.status == "archived" else "고객 보관")
        self.delete_button.setAccessibleName(self.delete_button.toolTip())
        for card in self.customer_cards:
            card.setProperty("selected", card.property("customer_id") == str(customer.id))
            card.style().unpolish(card)
            card.style().polish(card)
        self._update_form_state()
        self.customer_selected.emit(customer)

    def _render_photos(self, photos: tuple[str, ...]) -> None:
        self._photos, self._photo_index = photos, 0
        for container in (self.photo_gallery, self.preview_strip):
            while container.count():
                item = container.takeAt(0)
                widget = item.widget() if item else None
                if widget is not None:
                    widget.hide()
                    widget.deleteLater()
        if not photos and not self._demo_photos:
            self.large_photo.pixmap = QPixmap()
            self.large_photo.update()
            self.photo_caption.setText("등록된 사진 없음")
            self.photo_gallery.addWidget(label("등록된 고객 사진이 없습니다.", "muted", True), 0, 0)
            self.previous_photo.setEnabled(False)
            self.next_photo.setEnabled(False)
            return
        self.previous_photo.setEnabled(True)
        self.next_photo.setEnabled(True)
        for index in range(len(photos) if photos else 4):
            path = photos[index] if index < len(photos) else ""
            tile = PhotoTile(path, sample_index=index % 4)
            if index < len(getattr(self, "_photo_pixmaps", ())):
                tile.pixmap = self._photo_pixmaps[index]
            tile.setMinimumHeight(65)
            self.photo_gallery.addWidget(tile, index // 2, index % 2)
            if index < 4:
                thumbnail = QPushButton()
                thumbnail.setAccessibleName(f"사진 {index + 1} 보기")
                thumbnail.setFixedHeight(46)
                inner = QVBoxLayout(thumbnail)
                inner.setContentsMargins(1, 1, 1, 1)
                image = PhotoTile(path, sample_index=index)
                if index < len(getattr(self, "_photo_pixmaps", ())):
                    image.pixmap = self._photo_pixmaps[index]
                image.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
                inner.addWidget(image)
                thumbnail.clicked.connect(lambda checked=False, i=index: self._show_photo(i))
                self.preview_strip.addWidget(thumbnail, 1)
        self._show_photo(0)

    def _show_photo(self, index: int) -> None:
        if not self._photos and not self._demo_photos:
            return
        count = len(self._photos) or 4
        self._photo_index = index % count
        preview = PhotoTile(
            self._photos[self._photo_index] if self._photos else "",
            sample_index=self._photo_index % 4,
        )
        if self._photo_index < len(getattr(self, "_photo_pixmaps", ())):
            preview.pixmap = self._photo_pixmaps[self._photo_index]
        self.large_photo.pixmap = preview.pixmap
        self.large_photo.update()
        preview.deleteLater()
        prefix = "시술 사진" if self._photos else "샘플 이미지"
        self.photo_caption.setText(f"{prefix}   {self._photo_index + 1} / {count}")

    def _step_photo(self, direction: int) -> None:
        self._show_photo(self._photo_index + direction)

    def _load_customer_photos(self, customer_id: UUID) -> None:
        self._photo_generation += 1
        generation = self._photo_generation
        self._photo_loading = True
        self._photo_pixmaps = ()
        self.photo_caption.setText("사진을 불러오는 중…")
        self.photo_gallery.addWidget(label("사진을 불러오는 중…", "muted", True), 0, 0)
        worker = _PhotoRequest(
            generation,
            lambda: self._fetch_customer_photo_data(customer_id),
        )
        self._photo_workers.add(worker)
        worker.signals.finished.connect(self._photos_loaded, Qt.ConnectionType.QueuedConnection)
        QThreadPool.globalInstance().start(worker)

    def _retry_photo_load(self) -> None:
        if self._selected_id is not None and not self._photo_loading:
            self._load_customer_photos(self._selected_id)

    def _fetch_customer_photo_data(
        self, customer_id: UUID
    ) -> tuple[list[CustomerPhoto], list[bytes], int]:
        records = self._client.list_customer_photos(self._organization_id, customer_id)
        valid_records: list[CustomerPhoto] = []
        image_data: list[bytes] = []
        for record in records:
            try:
                data = self._client.download_customer_photo(
                    self._organization_id, customer_id, record.id
                )
                if data:
                    valid_records.append(record)
                    image_data.append(data)
            except Exception:
                continue
        return valid_records, image_data, len(records) - len(valid_records)

    @Slot(object)
    def _photos_loaded(self, outcome: tuple[_PhotoRequest, Any, Exception | None]) -> None:
        worker, result, error = outcome
        self._photo_workers.discard(worker)
        if worker.generation != self._photo_generation:
            return
        self._photo_loading = False
        if error is not None:
            self._photo_pixmaps = ()
            self._render_photos(())
            self._show_error("고객 사진을 불러오지 못했습니다. 다시 시도해 주세요.")
            return
        records, image_data, failed = result
        if self._selected_id is not None and not failed:
            self._photo_cache[self._selected_id] = (records, image_data)
        self._display_photo_data(records, image_data)
        if failed:
            self.photo_caption.setText(f"사진 {failed}개 조회 실패")
            self._show_error("일부 사진을 불러오지 못했습니다. 사진 새로고침으로 다시 시도하세요.")

    def _display_photo_data(self, records: list[CustomerPhoto], image_data: list[bytes]) -> None:
        pixmaps: list[QPixmap] = []
        for data in image_data:
            pixmap = QPixmap()
            if pixmap.loadFromData(data):
                pixmaps.append(pixmap)
        self._photo_pixmaps = tuple(pixmaps)
        self._render_photos(tuple("" for _ in pixmaps))
        self.photo_caption.setToolTip(
            " · ".join(record.caption for record in records if record.caption)
        )

    def _add_photo(self) -> None:
        if not self._can_manage or self._selected_id is None or self._photo_uploading:
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "고객 사진 선택", "", "이미지 파일 (*.jpg *.jpeg *.png *.webp)"
        )
        if not path:
            return
        content_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(Path(path).suffix.lower())
        if content_type is None:
            self._show_error("JPEG, PNG, WebP 이미지만 등록할 수 있습니다.")
            return
        try:
            content = Path(path).read_bytes()
            if not content or len(content) > 10 * 1024 * 1024:
                raise ValueError("사진 크기는 10MB 이하이어야 합니다.")
            self._pending_photo = (
                self._selected_id,
                Path(path).name,
                content,
                content_type,
                path,
            )
            self._start_photo_upload()
        except ValueError as exc:
            self._show_error(str(exc))
        except OSError:
            self._show_error("사진 파일을 읽지 못했습니다. 파일이 열려 있지 않은지 확인해 주세요.")

    def _start_photo_upload(self) -> None:
        if self._photo_uploading or self._pending_photo is None:
            return
        customer_id, name, content, content_type, _ = self._pending_photo
        self._photo_uploading = True
        self._upload_cancel.clear()
        self.upload_progress.setValue(0)
        self.upload_progress.show()
        self.cancel_upload_button.show()
        self.cancel_upload_button.setEnabled(True)
        customer_name = next((c.name for c in self._customers if c.id == customer_id), "고객")
        self.upload_status.setText(f"{customer_name} · {name} · 업로드 준비 중")
        self.add_photo_button.setEnabled(False)
        self.photo_retry_button.setVisible(False)
        self.photo_caption.setText("사진 업로드 중…")
        worker = _PhotoRequest(
            self._photo_generation,
            lambda: self._client.upload_customer_photo(
                self._organization_id,
                customer_id,
                name,
                content,
                content_type,
                on_progress=lambda sent, total: worker.signals.progress.emit((worker, sent, total)),
                is_cancelled=self._upload_cancel.is_set,
            ),
        )
        self._photo_upload_worker = worker
        worker.signals.progress.connect(
            self._photo_upload_progress, Qt.ConnectionType.QueuedConnection
        )
        worker.signals.finished.connect(
            self._photo_upload_finished, Qt.ConnectionType.QueuedConnection
        )
        QThreadPool.globalInstance().start(worker)

    def _cancel_photo_upload(self) -> None:
        if self._photo_uploading:
            self._upload_cancel.set()
            self.cancel_upload_button.setEnabled(False)
            self.upload_status.setText("취소 요청 중 · 진행 중인 통신이 끝나면 결과를 확인합니다.")

    @Slot(object)
    def _photo_upload_progress(self, outcome: tuple[_PhotoRequest, int, int]) -> None:
        worker, sent, total = outcome
        if worker is not self._photo_upload_worker or self._upload_cancel.is_set():
            return
        self.upload_progress.setValue(int(sent * 100 / max(total, 1)))
        if sent == total:
            self.upload_status.setText("전송 완료 · 서버 응답 확인 중")

    def _retry_photo_upload(self) -> None:
        if (
            self._selected_id is not None
            and self._pending_photo is not None
            and self._pending_photo[0] == self._selected_id
        ):
            self._start_photo_upload()

    @Slot(object)
    def _photo_upload_finished(self, outcome: tuple[_PhotoRequest, Any, Exception | None]) -> None:
        worker, _, error = outcome
        if worker is not self._photo_upload_worker:
            return
        self._photo_upload_worker = None
        self._photo_uploading = False
        self.upload_progress.hide()
        self.cancel_upload_button.hide()
        self.add_photo_button.setEnabled(self._can_manage and self._selected_id is not None)
        if error is not None:
            self.upload_status.setText(
                "업로드를 취소했습니다. 선택한 파일은 다시 시도할 수 있습니다."
                if isinstance(error, UploadCancelled)
                else str(error) or "사진 업로드 실패"
            )
            if self._pending_photo and self._pending_photo[0] == self._selected_id:
                self.photo_caption.setText(
                    "사진 업로드 취소" if isinstance(error, UploadCancelled) else "사진 업로드 실패"
                )
            self.photo_retry_button.setVisible(
                bool(self._pending_photo and self._pending_photo[0] == self._selected_id)
            )
            if not isinstance(error, UploadCancelled):
                self._show_error(
                    "사진 등록에 실패했습니다. 업로드 상태와 대상 고객을 확인해 주세요."
                )
            return
        customer_id = self._pending_photo[0] if self._pending_photo else self._selected_id
        self.upload_status.setText("사진 업로드 완료")
        self._pending_photo = None
        self.photo_retry_button.setVisible(False)
        self.error_label.clear()
        self.error_label.hide()
        if customer_id is not None:
            self._photo_cache.pop(customer_id, None)
            if customer_id == self._selected_id:
                self._load_customer_photos(customer_id)

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

    def _show_error(self, message: str) -> None:
        self.error_label.setText(message)
        self.error_label.show()

    def _save(self) -> bool:
        if not self._can_manage or self._saving:
            return False
        try:
            values = self.info_panel.values()
        except ValueError as exc:
            self._show_error(str(exc))
            return False
        self._saving = True
        self.save_button.setEnabled(False)
        try:
            if self._selected_id is None:
                customer = self._client.create_customer_record(self._organization_id, values)
                self._customers.append(customer)
            else:
                customer = self._client.update_customer(
                    self._organization_id, self._selected_id, values
                )
                self._customers = [customer if c.id == customer.id else c for c in self._customers]
            self.error_label.clear()
            self.error_label.hide()
            self._selected_id = customer.id
            self._render()
            # Updating profile must not discard a separate activity draft.
            self._selected_id = customer.id
            self.info_panel.populate(customer)
            self.profile_name.setText(customer.name)
            self.profile_contact.setText(customer.phone or "연락처 미등록")
            self.profile_tags.setText("  ·  ".join(customer.tags))
            self.memo_preview.setText(customer.notes or "등록된 메모가 없습니다.")
            self.activity_panel.set_customer(customer.id)
            self.delete_button.setToolTip(
                "고객 복원" if customer.status == "archived" else "고객 보관"
            )
            self.customer_selected.emit(customer)
            return True
        except Exception:
            self._show_error(
                "고객 저장에 실패했습니다. 입력은 유지됩니다. 연결과 권한을 확인해 주세요."
            )
            return False
        finally:
            self._saving = False
            self._update_form_state()

    def _archive_customer(self) -> None:
        if not self._can_manage or self._saving or self._selected_id is None:
            return
        if not self.confirm_leave():
            return
        current = next((c for c in self._customers if c.id == self._selected_id), None)
        if current is None:
            return
        archive = current.status != "archived"
        action = "보관" if archive else "복원"
        if (
            QMessageBox.question(
                self, f"고객 {action}", f"{current.name} 고객을 {action}할까요? 기록은 유지됩니다."
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            customer = self._client.update_customer(
                self._organization_id, current.id, {"status": "archived" if archive else "active"}
            )
            self._customers = [customer if c.id == customer.id else c for c in self._customers]
            self._render()
            self._apply_customer(customer)
            self.error_label.clear()
            self.error_label.hide()
        except Exception:
            self._show_error(f"고객 {action}에 실패했습니다. 다시 시도해 주세요.")

    def has_unsaved_changes(self) -> bool:
        return self._can_manage and (
            self.info_panel.is_dirty() or self.activity_panel.has_unsaved_changes()
        )

    def confirm_leave(self) -> bool:
        if self._saving or self.activity_panel.is_saving:
            self._show_error("저장 중입니다. 완료될 때까지 기다려 주세요.")
            return False
        if not self.has_unsaved_changes():
            return True
        # An activity is a separate record: save it using the composer before leaving.
        activity_dirty = self.activity_panel.has_unsaved_changes()
        buttons = QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel
        if not activity_dirty:
            buttons |= QMessageBox.StandardButton.Save
        choice = QMessageBox.question(
            self,
            "작성 중인 내용",
            "저장하지 않은 내용이 있습니다. 기록 입력란에서 저장하거나 변경을 버릴 수 있습니다."
            if activity_dirty
            else "고객 정보 변경을 저장할까요?",
            buttons,
            QMessageBox.StandardButton.Cancel,
        )
        if choice == QMessageBox.StandardButton.Cancel:
            return False
        if choice == QMessageBox.StandardButton.Save:
            return self._save()
        if choice == QMessageBox.StandardButton.Discard:
            self.activity_panel.discard_draft()
            current = next((c for c in self._customers if c.id == self._selected_id), None)
            self.info_panel.populate(current)
            return True
        return False

    def _update_form_state(self) -> None:
        self.add_photo_button.setEnabled(
            self._can_manage and self._selected_id is not None and not self._photo_uploading
        )
        self.photo_retry_button.setVisible(
            bool(
                not self._photo_uploading
                and self._pending_photo
                and self._pending_photo[0] == self._selected_id
            )
        )
        self.save_button.setEnabled(self._can_manage and not self._saving)
        self.delete_button.setEnabled(
            self._can_manage and self._selected_id is not None and not self._saving
        )
        text = "고객 등록" if self._selected_id is None else "정보 저장"
        self.save_button.setText(text + (" · 수정 중" if self.info_panel.is_dirty() else ""))

    def _new_customer(self) -> None:
        if self._can_manage and self.confirm_leave():
            self._clear_form()

    def _reset_filters(self) -> None:
        self.search_input.clear()
        self.filter_combo.setCurrentIndex(0)
        self.sort_combo.setCurrentIndex(0)

    def _clear_form(self) -> None:
        self.error_label.clear()
        self.error_label.hide()
        self._selected_id = None
        self.info_panel.populate(None)
        self.profile_name.setText("새 고객" if self._can_manage else "고객을 선택하세요")
        self.profile_contact.setText("연락처 · 최근 방문")
        self.profile_tags.clear()
        self.memo_preview.clear()
        self.activity_panel.set_customer(None)
        self._render_photos(())
        self._render()
        self._update_form_state()
