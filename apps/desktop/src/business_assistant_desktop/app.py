"""Qt application creation helpers."""

from collections.abc import Sequence

from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtWidgets import QApplication

from business_assistant_desktop.login_dialog import AuthenticationClient, LoginDialog
from business_assistant_desktop.main_window import MainWindow


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
        self.login_dialog = LoginDialog(api_client, self._show_main_window)

    def _show_main_window(self, entitlements: EntitlementSet) -> None:
        self.main_window = create_main_window(entitlements)
        self.main_window.show()
