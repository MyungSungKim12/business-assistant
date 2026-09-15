"""Executable module entry point for the desktop application."""

import sys

from business_assistant_desktop.app import create_application, create_desktop_shell_from_environment


def main() -> None:
    """Run the configured login shell."""
    application = create_application(sys.argv)
    try:
        shell = create_desktop_shell_from_environment()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    shell.login_dialog.show()
    sys.exit(application.exec())


if __name__ == "__main__":
    main()
