"""Qt application creation helpers."""

import os
from collections.abc import Sequence

import httpx
from business_assistant_common.entitlements import EntitlementSet
from dotenv import load_dotenv
from PySide6.QtWidgets import QApplication

from business_assistant_desktop.api_client import ApiClient
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
        application = QApplication(list(argv) if argv is not None else [])

    application.setOrganizationName("Business Assistant")
    application.setApplicationName("Business Assistant")
    application.setApplicationDisplayName("Business Assistant")
    return application


def create_main_window(entitlements: EntitlementSet) -> MainWindow:
    """Build a window from the currently server-authorized features."""
    return MainWindow(entitlements)


class DesktopShell:
    """Own the transition from authentication to an entitlement-gated main window."""

    def __init__(self, api_client: AuthenticationClient) -> None:
        self.main_window: MainWindow | None = None
        self._api_client = api_client
        self._organization_dialog: OrganizationDialog | None = None
        self.login_dialog = LoginDialog(
            api_client, self._show_main_window, self._show_organization_dialog
        )

    def _show_main_window(self, entitlements: EntitlementSet) -> None:
        self.main_window = create_main_window(entitlements)
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


def create_desktop_shell_from_environment() -> DesktopShell:
    """Create the login shell from the FastAPI URL supplied by the environment."""
    load_dotenv(override=False)
    api_url = os.environ.get("APP_API_BASE_URL") or os.environ.get("BUSINESS_ASSISTANT_API_URL")
    if not api_url:
        raise RuntimeError(
            "APP_API_BASE_URL is required; set it to the Business Assistant API URL."
        )
    return DesktopShell(ApiClient(api_url, httpx.Client(timeout=10.0)))
