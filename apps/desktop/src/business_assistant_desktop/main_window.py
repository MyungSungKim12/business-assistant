"""Product-style application shell and navigation."""

from typing import Any

from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtCore import Qt
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QPushButton,
    QSizePolicy,
    QStackedWidget,
    QStyle,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.customer_page import CustomerPage
from business_assistant_desktop.customer_widgets import SidebarPanel
from business_assistant_desktop.dashboard_page import DashboardPage
from business_assistant_desktop.design_tokens import application_stylesheet
from business_assistant_desktop.document_page import DocumentPage
from business_assistant_desktop.file_page import FilePage
from business_assistant_desktop.finance_page import FinancePage
from business_assistant_desktop.icons import icon
from business_assistant_desktop.menu_catalog import MENU_CATALOG
from business_assistant_desktop.task_page import TaskPage
from business_assistant_desktop.treatment_page import TreatmentPage


class PlaceholderPage(QFrame):
    def __init__(self, title: str, description: str, available: bool) -> None:
        super().__init__()
        self.setObjectName("content-card")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        heading = QLabel(title)
        heading.setObjectName("page-title")
        subtitle = QLabel(description)
        subtitle.setObjectName("page-subtitle")
        subtitle.setWordWrap(True)
        layout.addWidget(heading)
        layout.addWidget(subtitle)
        layout.addSpacing(18)
        state = QLabel(
            "화면을 준비하고 있습니다. 제공되는 기능은 왼쪽 메뉴에서 이용하세요."
            if available
            else "현재 구독에서 사용할 수 없는 기능입니다."
        )
        state.setObjectName("status")
        layout.addWidget(state)
        layout.addStretch()


class NavigationDelegate(QStyledItemDelegate):
    """Selection provides the location cue without Windows' text-only focus box."""

    def paint(self, painter: Any, option: QStyleOptionViewItem, index: Any) -> None:
        clean = QStyleOptionViewItem(option)
        clean.state &= ~QStyle.StateFlag.State_HasFocus
        super().paint(painter, clean, index)


class MainWindow(QMainWindow):
    """Application shell with consistent navigation and page states."""

    def __init__(
        self,
        entitlements: EntitlementSet,
        client: object | None = None,
        session: object | None = None,
        organization: object | None = None,
    ) -> None:
        super().__init__()
        self.setWindowTitle("Business Assistant")
        self.setMinimumSize(1100, 720)
        self.resize(1440, 920)
        self.setStyleSheet(application_stylesheet())

        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)
        body = QWidget()
        body_layout = QHBoxLayout(body)
        body_layout.setContentsMargins(0, 0, 0, 0)
        body_layout.setSpacing(0)
        self.navigation_menu = QListWidget()
        self.navigation_menu.setObjectName("navigation")
        self.navigation_menu.setFixedWidth(204)
        self.navigation_menu.setItemDelegate(NavigationDelegate(self.navigation_menu))
        self.navigation_menu.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.navigation_menu.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.navigation_menu.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.navigation_menu.setAccessibleName("주요 메뉴")
        self.navigation_menu.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Expanding)
        sidebar = SidebarPanel()
        sidebar.setObjectName("sidebar")
        sidebar.setFixedWidth(204)
        side_layout = QVBoxLayout(sidebar)
        side_layout.setContentsMargins(0, 0, 0, 16)
        side_layout.setSpacing(0)
        logo = QLabel("Business\nAssistant")
        logo.setObjectName("sidebar-brand")
        logo.setFixedHeight(100)
        brand_row = QHBoxLayout()
        brand_row.setContentsMargins(14, 0, 0, 0)
        brand_row.setSpacing(0)
        brand_mark = QLabel()
        brand_mark.setObjectName("brand-mark")
        brand_mark.setPixmap(icon("mdi6.leaf", "#DDCEBA").pixmap(26, 36))
        brand_row.addWidget(brand_mark)
        brand_row.addWidget(logo, 1)
        side_layout.addLayout(brand_row)
        side_layout.addWidget(self.navigation_menu, 1)
        self.all_menu_button = QPushButton("전체 메뉴")
        self.all_menu_button.setObjectName("all-menu-button")
        self.all_menu_button.setIcon(icon("mdi6.menu", "#b5aaa0"))
        side_layout.addWidget(self.all_menu_button)
        footer = QLabel("BEAUTY & BUSINESS\n매장 운영을 더 간결하게")
        footer.setObjectName("sidebar-footer")
        side_layout.addWidget(footer)
        self.pages = QStackedWidget()
        self._page_by_key: dict[str, int] = {}
        self._navigation_icons: list[str] = []
        for menu in MENU_CATALOG:
            available = menu.feature_code is None or entitlements.has(menu.feature_code)
            self.navigation_menu.addItem(menu.label)
            item = self.navigation_menu.item(self.navigation_menu.count() - 1)
            item.setToolTip(menu.label if available else f"{menu.label} · 사용 권한이 필요합니다")
            menu_icon = {
                "dashboard": "mdi6.home-outline",
                "crm": "mdi6.account-outline",
                "schedule": "mdi6.calendar-month-outline",
                "treatments": "mdi6.clipboard-text-outline",
                "documents": "mdi6.text-box-outline",
                "finance": "mdi6.wallet-outline",
                "files": "mdi6.folder-outline",
                "reports": "mdi6.chart-bar",
                "settings": "mdi6.cog-outline",
            }.get(menu.key, "mdi6.circle-small")
            self._navigation_icons.append(menu_icon)
            item.setIcon(icon(menu_icon, "#dfd9d1"))
            if not available:
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEnabled)
            page: QWidget = PlaceholderPage(menu.label, self._description(menu.key), available)
            if (
                menu.key == "crm"
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = CustomerPage(
                        _BoundCustomerClient(client, session),
                        organization_id,
                        can_manage=_can_manage(organization),
                    )
                    page.treatment_requested.connect(self._open_treatments)
            elif (
                menu.key == "treatments"
                and available
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = TreatmentPage(
                        _BoundTreatmentClient(client, session),
                        organization_id,
                        can_manage=_can_manage(organization),
                    )
            elif (
                menu.key == "schedule"
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = TaskPage(_BoundTaskClient(client, session), organization_id)
            elif (
                menu.key == "documents"
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = DocumentPage(
                        _BoundDocumentClient(client, session),
                        organization_id,
                        can_manage=_can_manage(organization),
                    )
            elif (
                menu.key == "finance"
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = FinancePage(
                        _BoundFinanceClient(client, session),
                        organization_id,
                        can_manage=_can_manage(organization),
                    )
            elif (
                menu.key == "files"
                and client is not None
                and session is not None
                and organization is not None
            ):
                organization_id = getattr(organization, "id", None)
                if organization_id is not None:
                    page = FilePage(
                        _BoundFileClient(client, session),
                        organization_id,
                        can_manage=_can_manage(organization),
                    )
            if menu.key == "dashboard" and client and session and organization:
                readers = {}
                if entitlements.has("crm.basic"):
                    readers["crm"] = lambda: sum(
                        c.status == "active"
                        for c in client.list_customers(organization.id, session)
                    )
                if entitlements.has("schedule.basic"):
                    readers["schedule"] = lambda: sum(
                        t.status in {"open", "in_progress"}
                        for t in client.list_tasks(organization.id, session)
                    )
                if entitlements.has("files.basic"):
                    readers["files"] = lambda: sum(
                        not f.is_archived for f in client.list_files(organization.id, session)
                    )
                page = DashboardPage(readers, organization.name)
                page.navigate.connect(
                    lambda key: self.navigation_menu.setCurrentRow(self._page_by_key[key])
                )
            self._page_by_key[menu.key] = self.pages.addWidget(page)
        content_area = QFrame()
        content_area.setObjectName("content-area")
        content_layout = QVBoxLayout(content_area)
        content_layout.setContentsMargins(0, 0, 0, 0)
        context_bar = QFrame()
        context_bar.setObjectName("workspace-context")
        context_row = QHBoxLayout(context_bar)
        context_row.setContentsMargins(24, 10, 24, 10)
        context_name = QLabel(str(getattr(organization, "name", "매장 워크스페이스")))
        context_name.setTextFormat(Qt.TextFormat.PlainText)
        context_name.setObjectName("context-name")
        context_row.addWidget(context_name)
        context_row.addStretch()
        context_hint = QLabel("고객과 매장의 모든 기록을 한곳에")
        context_hint.setObjectName("context-label")
        context_row.addWidget(context_hint)
        content_layout.setSpacing(0)
        content_layout.addWidget(context_bar)
        content_layout.addWidget(self.pages, 1)
        body_layout.addWidget(sidebar)
        body_layout.addWidget(content_area, 1)
        root_layout.addWidget(body, 1)
        self.setCentralWidget(root)
        self.navigation_menu.currentRowChanged.connect(self._navigate)
        self.navigation_menu.setCurrentRow(0)
        self._expanded_navigation = False
        self.all_menu_button.clicked.connect(self._toggle_navigation)
        self._apply_navigation_visibility()

    def _open_treatments(self, customer_id: Any) -> None:
        target = self.pages.widget(self._page_by_key["treatments"])
        current = self.pages.currentWidget()
        if not isinstance(target, TreatmentPage) or customer_id is None:
            return
        if isinstance(current, CustomerPage) and not current.confirm_leave():
            return
        if target.open_customer(customer_id):
            self.navigation_menu.setCurrentRow(self._page_by_key["treatments"])

    def _navigate(self, index: int) -> None:
        current = self.pages.currentWidget()
        if (
            index != self.pages.currentIndex()
            and isinstance(
                current,
                (CustomerPage, TreatmentPage, DocumentPage, FinancePage, TaskPage),
            )
            and not current.confirm_leave()
        ):
            self.navigation_menu.blockSignals(True)
            self.navigation_menu.setCurrentRow(self.pages.currentIndex())
            self.navigation_menu.blockSignals(False)
            return
        self.pages.setCurrentIndex(index)
        target = self.pages.currentWidget()
        if isinstance(target, DashboardPage):
            target.open_snapshot()
        for row, name in enumerate(self._navigation_icons):
            self.navigation_menu.item(row).setIcon(
                icon(name, "#293C53" if row == index else "#C0CAD6")
            )

    def closeEvent(self, event: QCloseEvent) -> None:
        for index in range(self.pages.count()):
            page = self.pages.widget(index)
            if (
                isinstance(page, (CustomerPage, TreatmentPage, DocumentPage, FinancePage, TaskPage))
                and not page.confirm_leave()
            ):
                event.ignore()
                return
        super().closeEvent(event)

    def _toggle_navigation(self) -> None:
        self._expanded_navigation = not self._expanded_navigation
        self._apply_navigation_visibility()

    def _apply_navigation_visibility(self) -> None:
        primary = {
            "dashboard",
            "crm",
            "schedule",
            "treatments",
            "documents",
            "finance",
            "files",
            "reports",
            "settings",
        }
        for index, menu in enumerate(MENU_CATALOG):
            self.navigation_menu.item(index).setHidden(
                not self._expanded_navigation and menu.key not in primary
            )
        self.all_menu_button.setText("간단히 보기" if self._expanded_navigation else "전체 메뉴")

    @staticmethod
    def _description(key: str) -> str:
        return {
            "dashboard": "오늘 해야 할 일과 업무 현황을 한눈에 확인하세요.",
            "crm": "고객과 거래처 정보를 조직 단위로 관리합니다.",
            "schedule": "업무 마감일과 진행 상태를 관리합니다.",
            "documents": "반복 문서를 템플릿으로 빠르게 작성합니다.",
            "finance": "수입·지출을 기록하고 기간별 합계를 확인합니다.",
            "files": "조직 파일을 안전하게 업로드하고 공유합니다.",
        }.get(key, "업무에 필요한 기능을 준비하고 있습니다.")


class _BoundCustomerClient:
    def __init__(self, client: Any, session: Any) -> None:
        self._client = client
        self._session = session

    def list_customers(self, organization_id: Any) -> Any:
        return self._client.list_customers(organization_id, self._session)

    def create_customer_record(self, organization_id: Any, values: dict[str, object]) -> Any:
        return self._client.create_customer_record(organization_id, self._session, values)

    def update_customer(
        self, organization_id: Any, customer_id: Any, values: dict[str, object]
    ) -> Any:
        return self._client.update_customer(organization_id, self._session, customer_id, values)

    def list_customer_activities(self, organization_id: Any, customer_id: Any) -> Any:
        return self._client.list_customer_activities(organization_id, self._session, customer_id)

    def create_customer_activity(
        self, organization_id: Any, customer_id: Any, values: dict[str, object]
    ) -> Any:
        return self._client.create_customer_activity(
            organization_id, self._session, customer_id, values
        )

    def list_customer_photos(self, organization_id: Any, customer_id: Any) -> Any:
        return self._client.list_customer_photos(organization_id, self._session, customer_id)

    def upload_customer_photo(
        self,
        organization_id: Any,
        customer_id: Any,
        original_name: str,
        content: bytes,
        content_type: str,
        caption: str = "",
        **transfer_options: Any,
    ) -> Any:
        return self._client.upload_customer_photo(
            organization_id,
            self._session,
            customer_id,
            original_name,
            content,
            content_type,
            caption,
            **transfer_options,
        )

    def download_customer_photo(
        self, organization_id: Any, customer_id: Any, photo_id: Any
    ) -> bytes:
        return self._client.download_customer_photo(
            organization_id, self._session, customer_id, photo_id
        )


class _BoundTreatmentClient(_BoundCustomerClient):
    def list_document_consent_events(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        document_id: Any,
    ) -> Any:
        return self._client.list_document_consent_events(
            organization_id, self._session, customer_id, treatment_id, document_id
        )

    def record_document_consent_event(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        document_id: Any,
        payload: Any,
    ) -> Any:
        return self._client.record_document_consent_event(
            organization_id, self._session, customer_id, treatment_id, document_id, payload
        )

    def list_document_templates(self, organization_id: Any) -> Any:
        return self._client.list_document_templates(organization_id, self._session)

    def preview_treatment_document(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        template_id: Any,
    ) -> Any:
        return self._client.preview_treatment_document(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
            template_id,
        )

    def issue_treatment_document(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        payload: Any,
    ) -> Any:
        return self._client.issue_treatment_document(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
            payload,
        )

    def list_issued_treatment_documents(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
    ) -> Any:
        return self._client.list_issued_treatment_documents(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
        )

    def preview_treatment_sale_draft(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        values: Any,
    ) -> Any:
        return self._client.preview_treatment_sale_draft(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
            values,
        )

    def create_treatment_sale_draft(
        self,
        organization_id: Any,
        customer_id: Any,
        treatment_id: Any,
        payload: Any,
    ) -> Any:
        return self._client.create_treatment_sale_draft(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
            payload,
        )

    def list_treatment_sale_drafts(
        self,
        organization_id: Any,
        customer_id: Any = None,
        treatment_id: Any = None,
    ) -> Any:
        return self._client.list_treatment_sale_drafts(
            organization_id,
            self._session,
            customer_id,
            treatment_id,
        )

    def mutate_treatment(
        self, organization_id: Any, customer_id: Any, record_id: Any, values: Any
    ) -> Any:
        return self._client.mutate_treatment(
            organization_id, self._session, customer_id, record_id, values
        )

    def list_treatment_events(self, organization_id: Any, customer_id: Any, record_id: Any) -> Any:
        return self._client.list_treatment_events(
            organization_id, self._session, customer_id, record_id
        )

    def list_treatments(self, organization_id: Any, customer_id: Any) -> Any:
        return self._client.list_treatments(organization_id, self._session, customer_id)

    def create_treatment(self, organization_id: Any, customer_id: Any, values: Any) -> Any:
        return self._client.create_treatment(organization_id, self._session, customer_id, values)

    def update_treatment(
        self, organization_id: Any, customer_id: Any, record_id: Any, values: Any
    ) -> Any:
        return self._client.update_treatment(
            organization_id, self._session, customer_id, record_id, values
        )


class _BoundTaskClient:
    """Adapt the session-aware HTTP client to the task page boundary."""

    def __init__(self, client: Any, session: Any) -> None:
        self._client, self._session = client, session

    def list_tasks(self, organization_id: Any, status: str | None = None) -> Any:
        return self._client.list_tasks(organization_id, self._session, status)

    def create_task(
        self,
        organization_id: Any,
        title: str,
        description: str,
        due_at: str | None,
        status: str,
        priority: str,
    ) -> Any:
        return self._client.create_task(
            organization_id,
            self._session,
            title,
            description,
            due_at,
            status,
            priority,
        )

    def update_task(self, organization_id: Any, task_id: Any, values: dict[str, Any]) -> Any:
        return self._client.update_task(organization_id, self._session, task_id, values)

    def delete_task(self, organization_id: Any, task_id: Any) -> Any:
        return self._client.delete_task(organization_id, self._session, task_id)


class _BoundDocumentClient:
    """Adapt the session-aware HTTP client to the document page boundary."""

    def __init__(self, client: Any, session: Any) -> None:
        self._client, self._session = client, session

    def list_document_templates(self, organization_id: Any) -> Any:
        return self._client.list_document_templates(organization_id, self._session)

    def mutate_document_template(self, organization_id: Any, template_id: Any, payload: Any) -> Any:
        return self._client.mutate_document_template(
            organization_id, self._session, template_id, payload
        )

    def list_document_template_versions(self, organization_id: Any, template_id: Any) -> Any:
        return self._client.list_document_template_versions(
            organization_id, self._session, template_id
        )

    def list_documents(self, organization_id: Any) -> Any:
        return self._client.list_documents(organization_id, self._session)

    def create_document(
        self, organization_id: Any, title: str, content: str, template_id: Any
    ) -> Any:
        return self._client.create_document(
            organization_id, self._session, title, content, template_id
        )


class _BoundFinanceClient:
    """Adapt the session-aware HTTP client to the finance page boundary."""

    def __init__(self, client: Any, session: Any) -> None:
        self._client, self._session = client, session

    @property
    def payment_recovery_identity(self) -> str:
        return f"{self._client.recovery_origin}\n{self._session.user_id}"

    def list_treatment_sale_drafts(self, organization_id: Any) -> Any:
        return self._client.list_sale_cart_drafts(organization_id, self._session)

    def get_visit_payments(self, organization_id: Any, visit_id: Any) -> Any:
        return self._client.get_visit_payments(organization_id, self._session, visit_id)

    def record_visit_payment(self, organization_id: Any, visit_id: Any, payload: Any) -> Any:
        return self._client.record_visit_payment(organization_id, self._session, visit_id, payload)

    def list_customers(self, organization_id: Any) -> Any:
        return self._client.list_customers(organization_id, self._session)

    def list_customer_visits(
        self, organization_id: Any, customer_id: Any = None, status: Any = None
    ) -> Any:
        return self._client.list_customer_visits(
            organization_id, self._session, customer_id, status
        )

    def create_customer_visit(
        self, organization_id: Any, customer_id: Any, operation_id: Any
    ) -> Any:
        return self._client.create_customer_visit(
            organization_id, self._session, customer_id, operation_id
        )

    def get_sale_cart(self, organization_id: Any, visit_id: Any) -> Any:
        return self._client.get_sale_cart(organization_id, self._session, visit_id)

    def add_treatment_draft_to_cart(self, organization_id: Any, *args: Any) -> Any:
        return self._client.add_treatment_draft_to_cart(organization_id, self._session, *args)

    def update_sale_cart_line(self, organization_id: Any, *args: Any) -> Any:
        return self._client.update_sale_cart_line(organization_id, self._session, *args)

    def remove_sale_cart_line(self, organization_id: Any, *args: Any) -> Any:
        return self._client.remove_sale_cart_line(organization_id, self._session, *args)

    def restore_sale_cart_line(self, organization_id: Any, *args: Any) -> Any:
        return self._client.restore_sale_cart_line(organization_id, self._session, *args)

    def review_sale_cart(self, organization_id: Any, *args: Any) -> Any:
        return self._client.review_sale_cart(organization_id, self._session, *args)

    def cancel_customer_visit(self, organization_id: Any, *args: Any) -> Any:
        return self._client.cancel_customer_visit(organization_id, self._session, *args)

    def list_transactions(
        self, organization_id: Any, transaction_type: Any, from_date: Any, to_date: Any
    ) -> Any:
        return self._client.list_transactions(
            organization_id, self._session, transaction_type, from_date, to_date
        )

    def get_finance_summary(self, organization_id: Any, from_date: Any, to_date: Any) -> Any:
        return self._client.get_finance_summary(organization_id, self._session, from_date, to_date)


class _BoundFileClient:
    """Adapt the session-aware HTTP client to the file page boundary."""

    def __init__(self, client: Any, session: Any) -> None:
        self._client, self._session = client, session

    def list_files(self, organization_id: Any) -> Any:
        return self._client.list_files(organization_id, self._session)

    def upload_file(self, organization_id: Any, path: Any) -> Any:
        return self._client.upload_file(organization_id, self._session, path)

    def get_download_url(self, organization_id: Any, file_id: Any) -> Any:
        return self._client.get_download_url(organization_id, self._session, file_id)

    def archive_file(self, organization_id: Any, file_id: Any) -> Any:
        return self._client.archive_file(organization_id, self._session, file_id)


def _can_manage(organization: object) -> bool:
    return getattr(organization, "role", "") in {"owner", "admin"}
