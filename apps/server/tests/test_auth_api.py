import asyncio
from uuid import UUID

import httpx
from business_assistant_common.auth import AuthSession, AuthUser
from business_assistant_server.dependencies.auth import AuthenticationError, get_auth_adapter
from business_assistant_server.main import create_app

USER = AuthUser(UUID("12345678-1234-5678-1234-567812345678"), "hana@example.com", "Hana")
SESSION = AuthSession(USER, "access-token", "refresh-token")


class FakeAuthAdapter:
    def __init__(self, *, reject_sign_in: bool = False) -> None:
        self.reject_sign_in = reject_sign_in

    async def sign_up(self, email: str, password: str, display_name: str) -> AuthSession:
        return SESSION

    async def sign_in(self, email: str, password: str) -> AuthSession:
        if self.reject_sign_in:
            raise AuthenticationError()
        return SESSION

    async def refresh(self, refresh_token: str) -> AuthSession:
        return SESSION

    async def verify_access_token(self, access_token: str) -> AuthUser:
        if access_token != "access-token":
            raise AuthenticationError()
        return USER


def _request(
    method: str,
    path: str,
    *,
    adapter: FakeAuthAdapter,
    json: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = lambda: adapter
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, path, json=json, headers=headers)

    return asyncio.run(send())


def test_login_returns_session_from_auth_adapter() -> None:
    response = _request(
        "POST",
        "/api/v1/auth/login",
        adapter=FakeAuthAdapter(),
        json={"email": "hana@example.com", "password": "correct-password"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "access_token": "access-token",
        "refresh_token": "refresh-token",
        "user": {
            "user_id": "12345678-1234-5678-1234-567812345678",
            "email": "hana@example.com",
            "display_name": "Hana",
        },
    }


def test_login_returns_401_for_invalid_credentials() -> None:
    response = _request(
        "POST",
        "/api/v1/auth/login",
        adapter=FakeAuthAdapter(reject_sign_in=True),
        json={"email": "hana@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid credentials"}


def test_signup_returns_session_from_auth_adapter() -> None:
    response = _request(
        "POST",
        "/api/v1/auth/signup",
        adapter=FakeAuthAdapter(),
        json={"email": "hana@example.com", "password": "correct-password", "display_name": "Hana"},
    )

    assert response.status_code == 200
    assert response.json()["access_token"] == "access-token"


def test_refresh_returns_replaced_session_from_auth_adapter() -> None:
    response = _request(
        "POST",
        "/api/v1/auth/refresh",
        adapter=FakeAuthAdapter(),
        json={"refresh_token": "refresh-token"},
    )

    assert response.status_code == 200
    assert response.json()["refresh_token"] == "refresh-token"


def test_me_requires_a_bearer_token() -> None:
    response = _request("GET", "/api/v1/me", adapter=FakeAuthAdapter())

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_me_returns_503_when_supabase_is_not_configured() -> None:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=create_app(), raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.get("/api/v1/me", headers={"Authorization": "Bearer access-token"})

    response = asyncio.run(send())

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication unavailable"}


def test_me_returns_the_user_verified_by_the_fake_adapter() -> None:
    response = _request(
        "GET",
        "/api/v1/me",
        adapter=FakeAuthAdapter(),
        headers={"Authorization": "Bearer access-token"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "user_id": "12345678-1234-5678-1234-567812345678",
        "email": "hana@example.com",
        "display_name": "Hana",
    }
