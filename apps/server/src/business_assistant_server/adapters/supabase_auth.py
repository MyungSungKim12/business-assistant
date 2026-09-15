import asyncio
from typing import Any
from uuid import UUID

from business_assistant_common.auth import AuthSession, AuthSignUpResult, AuthUser

from business_assistant_server.config import Settings
from business_assistant_server.dependencies.auth import (
    AuthenticationConfigurationError,
    AuthenticationError,
)


class SupabaseAuthAdapter:
    """Server-side boundary around the Supabase Auth client."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None

    async def sign_up(self, email: str, password: str, display_name: str) -> AuthSignUpResult:
        response = await self._call_auth(
            "sign_up",
            {
                "email": email,
                "password": password,
                "options": {"data": {"display_name": display_name}},
            },
        )
        return self._to_sign_up_result(response)

    async def sign_in(self, email: str, password: str) -> AuthSession:
        response = await self._call_auth(
            "sign_in_with_password", {"email": email, "password": password}
        )
        return self._to_session(response)

    async def refresh(self, refresh_token: str) -> AuthSession:
        response = await self._call_auth("refresh_session", refresh_token)
        return self._to_session(response)

    async def verify_access_token(self, access_token: str) -> AuthUser:
        try:
            response = await asyncio.to_thread(self._get_client().auth.get_user, access_token)
            return self._to_user(response.user)
        except AuthenticationConfigurationError:
            raise
        except Exception as error:
            raise AuthenticationError() from error

    async def _call_auth(self, method_name: str, argument: object) -> object:
        try:
            method = getattr(self._get_client().auth, method_name)
            return await asyncio.to_thread(method, argument)
        except AuthenticationConfigurationError:
            raise
        except Exception as error:
            raise AuthenticationError() from error

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if self._settings.supabase_url is None or self._settings.supabase_publishable_key is None:
            raise AuthenticationConfigurationError()
        try:
            from supabase import create_client
        except ImportError as error:
            raise AuthenticationConfigurationError() from error
        self._client = create_client(
            str(self._settings.supabase_url), self._settings.supabase_publishable_key
        )
        return self._client

    @staticmethod
    def _to_sign_up_result(response: object) -> AuthSignUpResult:
        session = getattr(response, "session", None)
        if session is None:
            if getattr(response, "user", None) is None:
                raise AuthenticationError()
            return AuthSignUpResult(session=None, email_confirmation_required=True)
        return AuthSignUpResult(
            session=SupabaseAuthAdapter._to_session(response),
            email_confirmation_required=False,
        )

    @staticmethod
    def _to_session(response: object) -> AuthSession:
        session = getattr(response, "session", None)
        user = getattr(response, "user", None) or getattr(session, "user", None)
        access_token = getattr(session, "access_token", None)
        if user is None or not isinstance(access_token, str):
            raise AuthenticationError()
        return AuthSession(
            user=SupabaseAuthAdapter._to_user(user),
            access_token=access_token,
            refresh_token=getattr(session, "refresh_token", None),
        )

    @staticmethod
    def _to_user(user: object) -> AuthUser:
        user_id = getattr(user, "id", None)
        email = getattr(user, "email", None)
        if not isinstance(user_id, str) or not isinstance(email, str):
            raise AuthenticationError()
        metadata = getattr(user, "user_metadata", None) or {}
        display_name = metadata.get("display_name") if isinstance(metadata, dict) else None
        return AuthUser(
            UUID(user_id), email, display_name if isinstance(display_name, str) else None
        )
