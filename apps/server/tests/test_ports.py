import inspect

from business_assistant_server.ports.auth import AuthPort
from business_assistant_server.ports.storage import StoragePort


def test_auth_port_exposes_token_verification() -> None:
    assert "verify_access_token" in AuthPort.__dict__
    assert inspect.iscoroutinefunction(AuthPort.verify_access_token)


def test_storage_port_exposes_upload_url_creation() -> None:
    assert "create_upload_url" in StoragePort.__dict__
    assert inspect.iscoroutinefunction(StoragePort.create_upload_url)
