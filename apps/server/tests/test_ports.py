import inspect
from uuid import UUID

from business_assistant_common.auth import AuthUser
from business_assistant_server.ports.auth import AuthPort
from business_assistant_server.ports.storage import StoragePort


def test_auth_port_exposes_token_verification() -> None:
    assert "verify_access_token" in AuthPort.__dict__
    assert inspect.iscoroutinefunction(AuthPort.verify_access_token)


def test_fake_auth_adapter_satisfies_auth_port_protocol() -> None:
    class FakeAuthAdapter:
        async def verify_access_token(self, access_token: str) -> AuthUser:
            return AuthUser(UUID("12345678-1234-5678-1234-567812345678"), "hana@example.com", None)

    assert isinstance(FakeAuthAdapter(), AuthPort)


def test_storage_port_exposes_upload_url_creation() -> None:
    assert "create_upload_url" in StoragePort.__dict__
    assert inspect.iscoroutinefunction(StoragePort.create_upload_url)
