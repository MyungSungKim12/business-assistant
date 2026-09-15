"""HTTP boundary between the desktop application and the Business Assistant API."""

from dataclasses import dataclass
from typing import cast
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet

from business_assistant_desktop.session import Session


@dataclass(frozen=True, slots=True)
class Organization:
    """An organization available to the authenticated user."""

    id: UUID
    name: str
    slug: str
    role: str


@dataclass(frozen=True, slots=True)
class SignUpResult:
    """Whether signup produced a session or awaits email confirmation."""

    session: Session | None
    email_confirmation_required: bool


class ApiClient:
    """Request authenticated data from the server without direct database access."""

    def __init__(self, base_url: str, client: httpx.Client) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client

    def login(self, email: str, password: str) -> Session:
        """Authenticate with the API and keep the returned tokens in the caller's session."""
        response = self._client.post(
            f"{self._base_url}/api/v1/auth/login",
            json={"email": email, "password": password},
        )
        response.raise_for_status()
        return _session_from_payload(_response_object(response))

    def sign_up(self, email: str, password: str, display_name: str) -> SignUpResult:
        """Create an account and report if email confirmation is required."""
        response = self._client.post(
            f"{self._base_url}/api/v1/auth/signup",
            json={"email": email, "password": password, "display_name": display_name},
        )
        response.raise_for_status()
        payload = _response_object(response)
        if payload.get("email_confirmation_required") is True:
            return SignUpResult(session=None, email_confirmation_required=True)
        return SignUpResult(
            session=_session_from_payload(payload),
            email_confirmation_required=False,
        )

    def list_organizations(self, session: Session) -> list[Organization]:
        """Return the organizations available to an authenticated user."""
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload: object = response.json()
        if not isinstance(payload, list):
            raise ValueError("Organization response must be a list")
        return [_organization_from_payload(_object(item)) for item in payload]

    def get_entitlements(self, organization_id: UUID, session: Session) -> EntitlementSet:
        """Return the server-calculated features for an organization."""
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/entitlements",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload = _response_object(response)
        features = payload.get("features")
        if not isinstance(features, list) or not all(
            isinstance(feature, str) for feature in features
        ):
            raise ValueError("Entitlement response must contain string features")
        return EntitlementSet(frozenset(features))


def _response_object(response: httpx.Response) -> dict[str, object]:
    return _object(response.json())


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("API response must be an object")
    return cast(dict[str, object], value)


def _required_string(payload: dict[str, object], field_name: str) -> str:
    value = payload.get(field_name)
    if not isinstance(value, str):
        raise ValueError(f"API response field {field_name} must be a string")
    return value


def _session_from_payload(payload: dict[str, object]) -> Session:
    refresh_token = payload.get("refresh_token")
    if refresh_token is not None and not isinstance(refresh_token, str):
        raise ValueError("API response field refresh_token must be a string or null")
    user = _object(payload.get("user"))
    return Session(
        access_token=_required_string(payload, "access_token"),
        refresh_token=refresh_token,
        user_id=UUID(_required_string(user, "user_id")),
    )


def _organization_from_payload(payload: dict[str, object]) -> Organization:
    return Organization(
        id=UUID(_required_string(payload, "id")),
        name=_required_string(payload, "name"),
        slug=_required_string(payload, "slug"),
        role=_required_string(payload, "role"),
    )
