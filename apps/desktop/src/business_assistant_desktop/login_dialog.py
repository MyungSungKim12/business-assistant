"""Login and signup dialog for the desktop shell."""

from collections.abc import Callable
from typing import Protocol
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtWidgets import (
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
)

from business_assistant_desktop.api_client import Organization, SignUpResult
from business_assistant_desktop.session import Session


class AuthenticationClient(Protocol):
    """Desktop-facing API operations used during authentication."""

    def login(self, email: str, password: str) -> Session: ...

    def sign_up(self, email: str, password: str, display_name: str) -> SignUpResult: ...

    def list_organizations(self, session: Session) -> list[Organization]: ...

    def get_entitlements(self, organization_id: UUID, session: Session) -> EntitlementSet: ...


class LoginDialog(QDialog):
    """Authenticate a user and hand server entitlements to the desktop shell."""

    def __init__(
        self,
        api_client: AuthenticationClient,
        on_authenticated: Callable[[EntitlementSet], None],
    ) -> None:
        super().__init__()
        self._api_client = api_client
        self._on_authenticated = on_authenticated
        self.setWindowTitle("Business Assistant 로그인")

        self.email_input = QLineEdit()
        self.email_input.setObjectName("email-input")
        self.password_input = QLineEdit()
        self.password_input.setObjectName("password-input")
        self.password_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.login_button = QPushButton("로그인")
        self.signup_button = QPushButton("가입")
        self.loading_label = QLabel()
        self.error_label = QLabel()
        self.error_label.setWordWrap(True)

        form = QFormLayout()
        form.addRow("이메일", self.email_input)
        form.addRow("비밀번호", self.password_input)
        buttons = QHBoxLayout()
        buttons.addWidget(self.login_button)
        buttons.addWidget(self.signup_button)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addLayout(buttons)
        layout.addWidget(self.loading_label)
        layout.addWidget(self.error_label)

        self.login_button.clicked.connect(self._login)
        self.signup_button.clicked.connect(self._sign_up)

    def _login(self) -> None:
        self._run_authentication(
            lambda: self._api_client.login(self.email_input.text(), self.password_input.text())
        )

    def _sign_up(self) -> None:
        try:
            self._begin_request("가입 중...")
            result = self._api_client.sign_up(
                self.email_input.text(),
                self.password_input.text(),
                self.email_input.text().partition("@")[0],
            )
            if result.email_confirmation_required:
                self.error_label.setText("이메일을 확인한 뒤 로그인해 주세요.")
                return
            if result.session is None:
                self.error_label.setText("가입 결과를 확인할 수 없습니다. 다시 시도해 주세요.")
                return
            self._complete_authentication(result.session)
        except (httpx.HTTPError, ValueError):
            self.error_label.setText("서버 요청에 실패했습니다. 다시 시도해 주세요.")
        finally:
            self._end_request()

    def _run_authentication(self, authenticate: Callable[[], Session]) -> None:
        try:
            self._begin_request("로그인 중...")
            self._complete_authentication(authenticate())
        except (httpx.HTTPError, ValueError):
            self.error_label.setText("서버 요청에 실패했습니다. 다시 시도해 주세요.")
        finally:
            self._end_request()

    def _complete_authentication(self, session: Session) -> None:
        organizations = self._api_client.list_organizations(session)
        if not organizations:
            self.error_label.setText("조직이 없습니다. 관리자에게 조직 생성을 요청해 주세요.")
            return
        entitlements = self._api_client.get_entitlements(organizations[0].id, session)
        self._on_authenticated(entitlements)
        self.accept()

    def _begin_request(self, message: str) -> None:
        self.error_label.clear()
        self.loading_label.setText(message)
        self.login_button.setEnabled(False)
        self.signup_button.setEnabled(False)

    def _end_request(self) -> None:
        self.loading_label.clear()
        self.login_button.setEnabled(True)
        self.signup_button.setEnabled(True)
