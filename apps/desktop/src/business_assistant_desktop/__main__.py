"""Executable module entry point for the desktop application."""

import sys

from business_assistant_common.entitlements import EntitlementSet

from business_assistant_desktop.app import create_application, create_main_window


def main() -> None:
    """Run the desktop shell with no protected features enabled."""
    application = create_application(sys.argv)
    window = create_main_window(EntitlementSet(frozenset()))
    window.show()
    sys.exit(application.exec())


if __name__ == "__main__":
    main()
