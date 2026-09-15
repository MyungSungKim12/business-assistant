from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.api_client import Organization, SignUpResult
from business_assistant_desktop.app import DesktopShell
from business_assistant_desktop.session import Session
from PySide6.QtCore import Qt

USER_ID = UUID("12345678-1234-5678-1234-567812345678")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
SESSION = Session("access-token", "refresh-token", USER_ID)


class SuccessfulApiClient:
    def login(self, email: str, password: str) -> Session:
        return SESSION

    def sign_up(self, email: str, password: str, display_name: str) -> SignUpResult:
        return SignUpResult(session=SESSION, email_confirmation_required=False)

    def list_organizations(self, session: Session) -> list[Organization]:
        return [Organization(ORGANIZATION_ID, "Hana Studio", "hana-studio", "owner")]

    def get_entitlements(self, organization_id: UUID, session: Session) -> EntitlementSet:
        return EntitlementSet(frozenset({"crm.basic"}))


def test_successful_login_transitions_to_an_entitled_main_window(qtbot) -> None:  # type: ignore[no-untyped-def]
    shell = DesktopShell(SuccessfulApiClient())
    qtbot.addWidget(shell.login_dialog)
    shell.login_dialog.show()
    shell.login_dialog.email_input.setText("hana@example.com")
    shell.login_dialog.password_input.setText("correct-password")

    qtbot.mouseClick(shell.login_dialog.login_button, Qt.MouseButton.LeftButton)

    assert shell.main_window is not None
    assert shell.main_window.navigation_menu.item(1).flags() & Qt.ItemFlag.ItemIsEnabled
    assert not shell.login_dialog.isVisible()


def test_signup_shows_explicit_email_confirmation_message(qtbot) -> None:  # type: ignore[no-untyped-def]
    class ConfirmationRequiredApiClient(SuccessfulApiClient):
        def sign_up(self, email: str, password: str, display_name: str) -> SignUpResult:
            return SignUpResult(session=None, email_confirmation_required=True)

    shell = DesktopShell(ConfirmationRequiredApiClient())
    qtbot.addWidget(shell.login_dialog)
    shell.login_dialog.email_input.setText("hana@example.com")
    shell.login_dialog.password_input.setText("correct-password")

    qtbot.mouseClick(shell.login_dialog.signup_button, Qt.MouseButton.LeftButton)

    assert shell.login_dialog.error_label.text() == "이메일을 확인한 뒤 로그인해 주세요."
    assert shell.main_window is None


def test_login_shows_a_clear_server_error_without_transition(qtbot) -> None:  # type: ignore[no-untyped-def]
    class FailingApiClient(SuccessfulApiClient):
        def login(self, email: str, password: str) -> Session:
            request = httpx.Request("POST", "https://api.example.test/api/v1/auth/login")
            response = httpx.Response(401, request=request)
            raise httpx.HTTPStatusError("invalid credentials", request=request, response=response)

    shell = DesktopShell(FailingApiClient())
    qtbot.addWidget(shell.login_dialog)
    shell.login_dialog.email_input.setText("hana@example.com")
    shell.login_dialog.password_input.setText("wrong-password")

    qtbot.mouseClick(shell.login_dialog.login_button, Qt.MouseButton.LeftButton)

    assert shell.login_dialog.error_label.text() == "서버 요청에 실패했습니다. 다시 시도해 주세요."
    assert shell.main_window is None


def test_login_without_an_organization_shows_a_next_step_message(qtbot) -> None:  # type: ignore[no-untyped-def]
    class NoOrganizationApiClient(SuccessfulApiClient):
        def list_organizations(self, session: Session) -> list[Organization]:
            return []

    shell = DesktopShell(NoOrganizationApiClient())
    qtbot.addWidget(shell.login_dialog)
    shell.login_dialog.email_input.setText("hana@example.com")
    shell.login_dialog.password_input.setText("correct-password")

    qtbot.mouseClick(shell.login_dialog.login_button, Qt.MouseButton.LeftButton)

    assert (
        shell.login_dialog.error_label.text()
        == "조직이 없습니다. 관리자에게 조직 생성을 요청해 주세요."
    )
    assert shell.main_window is None
