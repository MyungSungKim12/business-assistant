"""Login and signup dialog for the desktop shell."""

from collections.abc import Callable
from typing import Protocol
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtCore import QObject, QThread, Signal, Slot
from PySide6.QtGui import QCloseEvent
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


class AuthenticationWorker(QObject):
    """Run the complete FastAPI authentication sequence outside the UI thread."""

    authenticated = Signal(object)
    confirmation_required = Signal()
    organization_required = Signal()
    failed = Signal()
    finished = Signal()

    def __init__(
        self,
        api_client: AuthenticationClient,
        action: str,
        email: str,
        password: str,
    ) -> None:
        super().__init__()
        self._api_client = api_client
        self._action = action
        self._email = email
        self._password = password

    @Slot()
    def run(self) -> None:
        try:
            session = self._authenticate()
            if session is None:
                return
            organizations = self._api_client.list_organizations(session)
            if not organizations:
                self.organization_required.emit()
                return
            entitlements = self._api_client.get_entitlements(organizations[0].id, session)
            self.authenticated.emit(entitlements)
        except (httpx.HTTPError, ValueError):
            self.failed.emit()
        finally:
            self.finished.emit()

    def _authenticate(self) -> Session | None:
        if self._action == "login":
            return self._api_client.login(self._email, self._password)
        result = self._api_client.sign_up(
            self._email,
            self._password,
            self._email.partition("@")[0],
        )
        if result.email_confirmation_required:
            self.confirmation_required.emit()
            return None
        if result.session is None:
            self.failed.emit()
            return None
        return result.session


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
        self._thread: QThread | None = None
        self._worker: AuthenticationWorker | None = None
        self._authentication_succeeded = False
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
        self._start_request("login", "로그인 중...")

    def _sign_up(self) -> None:
        self._start_request("signup", "가입 중...")

    def _start_request(self, action: str, message: str) -> None:
        self._begin_request(message)
        thread = QThread(self)
        worker = AuthenticationWorker(
            self._api_client,
            action,
            self.email_input.text(),
            self.password_input.text(),
        )
        self._thread = thread
        self._worker = worker
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.authenticated.connect(self._complete_authentication)
        worker.confirmation_required.connect(self._show_confirmation_required)
        worker.organization_required.connect(self._show_organization_required)
        worker.failed.connect(self._show_request_error)
        worker.finished.connect(thread.quit)
        worker.finished.connect(worker.deleteLater)
        thread.finished.connect(self._finish_request)
        thread.finished.connect(thread.deleteLater)
        thread.start()

    def _complete_authentication(self, entitlements: EntitlementSet) -> None:
        self._on_authenticated(entitlements)
        self._authentication_succeeded = True

    def _show_confirmation_required(self) -> None:
        self.error_label.setText("이메일을 확인한 뒤 로그인해 주세요.")

    def _show_organization_required(self) -> None:
        self.error_label.setText("조직이 없습니다. 관리자에게 조직 생성을 요청해 주세요.")

    def _show_request_error(self) -> None:
        self.error_label.setText("서버 요청에 실패했습니다. 다시 시도해 주세요.")

    def _begin_request(self, message: str) -> None:
        self.error_label.clear()
        self.loading_label.setText(message)
        self.login_button.setEnabled(False)
        self.signup_button.setEnabled(False)

    def _finish_request(self) -> None:
        self.loading_label.clear()
        self.login_button.setEnabled(True)
        self.signup_button.setEnabled(True)
        self._thread = None
        self._worker = None
        if self._authentication_succeeded:
            self._authentication_succeeded = False
            self.accept()

    def closeEvent(self, event: QCloseEvent) -> None:
        """Keep the dialog alive until its worker has stopped."""
        if self._thread is not None and self._thread.isRunning():
            event.ignore()
            return
        super().closeEvent(event)
