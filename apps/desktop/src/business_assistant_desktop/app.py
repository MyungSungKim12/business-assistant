"""Qt application creation helpers."""

from collections.abc import Sequence

from PySide6.QtWidgets import QApplication


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
