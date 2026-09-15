import asyncio

import pytest
from business_assistant_common.auth import AuthUser
from business_assistant_server.dependencies.auth import (
    AuthAdapter,
    AuthenticationError,
    get_current_user,
)
from business_assistant_server.ports.auth import AuthPort
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials


class RejectingAuthAdapter:
    async def verify_access_token(self, access_token: str) -> AuthUser:
        raise AuthenticationError()


def test_auth_adapter_reuses_the_auth_port_contract() -> None:
    assert AuthPort in AuthAdapter.__mro__


def test_current_user_converts_an_invalid_bearer_token_to_401() -> None:
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="invalid-token")

    with pytest.raises(HTTPException) as raised:
        asyncio.run(get_current_user(credentials, RejectingAuthAdapter()))

    assert raised.value.status_code == 401
    assert raised.value.detail == "Invalid credentials"
