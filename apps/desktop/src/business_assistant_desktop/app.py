"""Qt application creation helpers."""

import os
from collections.abc import Sequence
from pathlib import Path

import httpx
from business_assistant_common.entitlements import EntitlementSet
from dotenv import load_dotenv
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtWidgets import QApplication

from business_assistant_desktop.api_client import ApiClient, Organization
from business_assistant_desktop.design_tokens import application_stylesheet
from business_assistant_desktop.login_dialog import AuthenticationClient, LoginDialog
from business_assistant_desktop.main_window import MainWindow
from business_assistant_desktop.organization_dialog import OrganizationDialog
from business_assistant_desktop.session import Session


def create_application(argv: Sequence[str] | None = None) -> QApplication:
    """Create or reuse the application and apply product metadata."""
    existing_application = QApplication.instance()
    if isinstance(existing_application, QApplication):
        application = existing_application
    else:
        QApplication.setHighDpiScaleFactorRoundingPolicy(
            Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
        )
        application = QApplication(list(argv) if argv is not None else [])

    application.setOrganizationName("Business Assistant")
    application.setApplicationName("Business Assistant")
    application.setApplicationDisplayName("Business Assistant")
    if not application.property("product-font-loaded"):
        font_root = Path(__file__).parent / "assets"
        font_ids = [
            QFontDatabase.addApplicationFont(str(font_root / f"Pretendard-{weight}.ttf"))
            for weight in ("Regular", "Medium", "SemiBold", "Bold")
        ]
        if all(font_id >= 0 for font_id in font_ids):
            application.setProperty("product-font-loaded", True)
    if not application.styleSheet():
        application.setStyle("Fusion")
        font = QFont("Pretendard")
        font.setPixelSize(14)
        # Keep Windows' native outline rasterisation and snap small Korean glyphs
        # to the device pixel grid. Forcing PreferAntialias makes 125/150% text
        # look soft on some ClearType configurations.
        font.setHintingPreference(QFont.HintingPreference.PreferFullHinting)
        font.setStyleStrategy(QFont.StyleStrategy.PreferDefault)
        application.setFont(font)
        application.setStyleSheet(application_stylesheet())
    return application


def create_main_window(entitlements: EntitlementSet) -> MainWindow:
    """Build a window from the currently server-authorized features."""
    return MainWindow(entitlements)


class DesktopShell:
    """Own the transition from authentication to an entitlement-gated main window."""

    def __init__(self, api_client: AuthenticationClient) -> None:
        self.main_window: MainWindow | None = None
        self._context_handled = False
        self._api_client = api_client
        self._organization_dialog: OrganizationDialog | None = None
        self.login_dialog = LoginDialog(
            api_client,
            self._show_main_window,
            self._show_organization_dialog,
            self._show_authenticated_context,
        )

    def _show_main_window(self, entitlements: EntitlementSet) -> None:
        if self._context_handled:
            self._context_handled = False
            return
        self.main_window = create_main_window(entitlements)
        self.main_window.show()

    def _show_authenticated_context(self, context: object) -> None:
        if not isinstance(context, tuple) or len(context) != 3:
            return
        entitlements, session, organization = context
        if isinstance(entitlements, EntitlementSet) and isinstance(organization, Organization):
            self._context_handled = True
            self.main_window = MainWindow(entitlements, self._api_client, session, organization)
            self.main_window.show()

    def _show_organization_dialog(self, session: Session) -> None:
        self._organization_dialog = OrganizationDialog(
            lambda name, slug: self._api_client.create_organization(name, slug, session),
            lambda organization: self._complete_organization(session, organization),
        )
        self._organization_dialog.show()

    def _complete_organization(self, session: Session, organization: object) -> None:
        if hasattr(organization, "id"):
            org_id = organization.id
            entitlements = self._api_client.get_entitlements(org_id, session)
            self._show_main_window(entitlements)
            self.login_dialog.accept()

    def start_dev_auto_login(self, email: str, password: str) -> None:
        """Start a development-only login using credentials supplied by the environment."""
        self.login_dialog.email_input.setText(email)
        self.login_dialog.password_input.setText(password)
        QTimer.singleShot(0, self.login_dialog._login)


def create_desktop_shell_from_environment() -> DesktopShell:
    """Create the login shell from the FastAPI URL supplied by the environment."""
    load_dotenv(override=False)
    api_url = os.environ.get("APP_API_BASE_URL") or os.environ.get("BUSINESS_ASSISTANT_API_URL")
    if not api_url:
        raise RuntimeError(
            "APP_API_BASE_URL is required; set it to the Business Assistant API URL."
        )
    shell = DesktopShell(ApiClient(api_url, httpx.Client(timeout=10.0)))
    if os.environ.get("BUSINESS_ASSISTANT_DEV_AUTO_LOGIN", "").lower() in {"1", "true", "yes"}:
        email = os.environ.get("BUSINESS_ASSISTANT_DEV_EMAIL")
        password = os.environ.get("BUSINESS_ASSISTANT_DEV_PASSWORD")
        if email and password:
            shell.start_dev_auto_login(email, password)
    return shell
