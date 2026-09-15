import pytest
from business_assistant_desktop import __main__ as desktop_main
from business_assistant_desktop.app import create_desktop_shell_from_environment


def test_shell_factory_requires_an_api_url(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("BUSINESS_ASSISTANT_API_URL", raising=False)

    with pytest.raises(RuntimeError, match="BUSINESS_ASSISTANT_API_URL"):
        create_desktop_shell_from_environment()


def test_main_shows_the_configured_login_shell(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    class FakeApplication:
        def exec(self) -> int:
            return 0

    class FakeLoginDialog:
        def __init__(self) -> None:
            self.was_shown = False

        def show(self) -> None:
            self.was_shown = True

    class FakeShell:
        def __init__(self) -> None:
            self.login_dialog = FakeLoginDialog()

    shell = FakeShell()
    monkeypatch.setattr(desktop_main, "create_application", lambda argv: FakeApplication())
    monkeypatch.setattr(desktop_main, "create_desktop_shell_from_environment", lambda: shell)

    with pytest.raises(SystemExit) as raised:
        desktop_main.main()

    assert raised.value.code == 0
    assert shell.login_dialog.was_shown is True
