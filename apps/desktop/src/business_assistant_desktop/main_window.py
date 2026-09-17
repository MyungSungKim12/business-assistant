"""Product-style application shell and navigation."""

from typing import Any

from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QPushButton,
    QSizePolicy,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.customer_page import CustomerPage
from business_assistant_desktop.document_page import DocumentPage
from business_assistant_desktop.file_page import FilePage
from business_assistant_desktop.finance_page import FinancePage
from business_assistant_desktop.menu_catalog import MENU_CATALOG
from business_assistant_desktop.task_page import TaskPage

_STYLE = """
QMainWindow, QWidget { background: #f7f8fa; color: #1f2937; }
#top-bar { background: #ffffff; border-bottom: 1px solid #e5e7eb; }
#brand { font-size: 18px; font-weight: 700; color: #111827; }
#context, #page-subtitle, #status { color: #6b7280; }
#navigation { background: #111827; border: 0; padding: 10px 8px; }
#navigation::item { color: #cbd5e1; padding: 11px 12px; border-radius: 7px; }
#navigation::item:selected, #navigation::item:hover { background: #2563eb; color: #ffffff; }
#navigation::item:disabled { color: #64748b; }
#content-card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; }
#page-title { font-size: 24px; font-weight: 700; color: #111827; }
QPushButton { background: #2563eb; color: white; border: 0; border-radius: 6px;
 padding: 9px 16px; font-weight: 600; }
"""


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
            "이 기능을 사용할 수 있습니다."
            if available
            else "현재 구독에서 사용할 수 없는 기능입니다."
        )
        state.setObjectName("status")
        layout.addWidget(state)
        layout.addStretch()


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
        self.resize(1280, 820)
        self.setStyleSheet(_STYLE)

        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)
        top_bar = QFrame()
        top_bar.setObjectName("top-bar")
        top_layout = QHBoxLayout(top_bar)
        top_layout.setContentsMargins(22, 14, 22, 14)
        brand = QLabel("Business Assistant")
        brand.setObjectName("brand")
        context = QLabel("내 조직  ·  현재 구독")
        context.setObjectName("context")
        account = QPushButton("계정")
        top_layout.addWidget(brand)
        top_layout.addSpacing(20)
        top_layout.addWidget(context)
        top_layout.addStretch()
        top_layout.addWidget(account)
        root_layout.addWidget(top_bar)

        body = QWidget()
        body_layout = QHBoxLayout(body)
        body_layout.setContentsMargins(0, 0, 0, 0)
        body_layout.setSpacing(0)
        self.navigation_menu = QListWidget()
        self.navigation_menu.setObjectName("navigation")
        self.navigation_menu.setFixedWidth(240)
        self.navigation_menu.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Expanding)
        self.pages = QStackedWidget()
        self._page_by_key: dict[str, int] = {}
        for menu in MENU_CATALOG:
            available = menu.feature_code is None or entitlements.has(menu.feature_code)
            self.navigation_menu.addItem(menu.label if available else f"{menu.label} (준비 중)")
            item = self.navigation_menu.item(self.navigation_menu.count() - 1)
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
                    page = CustomerPage(_BoundCustomerClient(client, session), organization_id)
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
                    page = FinancePage(_BoundFinanceClient(client, session), organization_id)
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
            self._page_by_key[menu.key] = self.pages.addWidget(page)
        body_layout.addWidget(self.navigation_menu)
        body_layout.addWidget(self.pages, 1)
        root_layout.addWidget(body, 1)
        self.setCentralWidget(root)
        self.navigation_menu.currentRowChanged.connect(self.pages.setCurrentIndex)
        self.navigation_menu.setCurrentRow(0)

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

    def create_customer(
        self, organization_id: Any, name: str, email: str | None, phone: str | None, notes: str
    ) -> Any:
        return self._client.create_customer(
            organization_id, self._session, name, email, phone, notes
        )

    def update_customer(
        self, organization_id: Any, customer_id: Any, values: dict[str, str | None]
    ) -> Any:
        return self._client.update_customer(organization_id, self._session, customer_id, values)

    def delete_customer(self, organization_id: Any, customer_id: Any) -> bool:
        self._client.delete_customer(organization_id, self._session, customer_id)
        return True


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
