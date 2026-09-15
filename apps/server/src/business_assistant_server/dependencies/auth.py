from typing import Annotated, Protocol

from business_assistant_common.auth import AuthSession, AuthUser
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from business_assistant_server.config import Settings
from business_assistant_server.ports.auth import AuthPort


class AuthenticationError(Exception):
    """Authentication failed without exposing provider details."""


class AuthenticationConfigurationError(Exception):
    """The server does not have the required provider configuration."""


class AuthAdapter(AuthPort, Protocol):
    async def sign_up(self, email: str, password: str, display_name: str) -> AuthSession: ...

    async def sign_in(self, email: str, password: str) -> AuthSession: ...

    async def refresh(self, refresh_token: str) -> AuthSession: ...


bearer_scheme = HTTPBearer(auto_error=False)


def get_settings() -> Settings:
    return Settings()


def get_auth_adapter(settings: Annotated[Settings, Depends(get_settings)]) -> AuthAdapter:
    from business_assistant_server.adapters.supabase_auth import SupabaseAuthAdapter

    return SupabaseAuthAdapter(settings)


async def get_current_user(
    authorization: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
    auth_adapter: Annotated[AuthAdapter, Depends(get_auth_adapter)],
) -> AuthUser:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return await auth_adapter.verify_access_token(authorization.credentials)
    except AuthenticationConfigurationError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication unavailable",
        ) from None
    except AuthenticationError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
