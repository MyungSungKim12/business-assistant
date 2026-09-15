from typing import Protocol, runtime_checkable

from business_assistant_common.auth import AuthUser


@runtime_checkable
class AuthPort(Protocol):
    async def verify_access_token(self, access_token: str) -> AuthUser:
        """Return the authenticated user."""
        ...
