"""HTTP boundary between the desktop application and the Business Assistant API."""

from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet

from business_assistant_desktop.session import Session


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
        payload = response.json()
        user = payload["user"]
        return Session(
            access_token=payload["access_token"],
            refresh_token=payload["refresh_token"],
            user_id=UUID(user["user_id"]),
        )

    def get_entitlements(self, organization_id: UUID, session: Session) -> EntitlementSet:
        """Return the server-calculated features for an organization."""
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/entitlements",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload = response.json()
        return EntitlementSet(frozenset(payload["features"]))
