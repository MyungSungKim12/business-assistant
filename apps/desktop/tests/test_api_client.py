import json
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.api_client import ApiClient, Organization
from business_assistant_desktop.session import Session

USER_ID = UUID("12345678-1234-5678-1234-567812345678")
ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")


def test_login_converts_server_response_to_session() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/login"
        assert json.loads(request.content) == {
            "email": "hana@example.com",
            "password": "correct-password",
        }
        return httpx.Response(
            200,
            json={
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "user": {
                    "user_id": str(USER_ID),
                    "email": "hana@example.com",
                    "display_name": "Hana",
                },
            },
        )

    client = ApiClient(
        "https://api.example.test", httpx.Client(transport=httpx.MockTransport(respond))
    )

    assert client.login("hana@example.com", "correct-password") == Session(
        "access-token", "refresh-token", USER_ID
    )


def test_get_entitlements_uses_bearer_session_and_converts_features() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/api/v1/organizations/{ORGANIZATION_ID}/entitlements"
        assert request.headers["Authorization"] == "Bearer access-token"
        return httpx.Response(
            200,
            json={
                "organization_id": str(ORGANIZATION_ID),
                "plan_code": "BASIC",
                "features": ["crm.basic", "dashboard.basic"],
            },
        )

    client = ApiClient(
        "https://api.example.test", httpx.Client(transport=httpx.MockTransport(respond))
    )
    session = Session("access-token", "refresh-token", USER_ID)

    assert client.get_entitlements(ORGANIZATION_ID, session) == EntitlementSet(
        frozenset({"crm.basic", "dashboard.basic"})
    )


def test_sign_up_reports_email_confirmation_requirement_without_a_session() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/signup"
        assert json.loads(request.content) == {
            "email": "hana@example.com",
            "password": "correct-password",
            "display_name": "Hana",
        }
        return httpx.Response(200, json={"email_confirmation_required": True})

    client = ApiClient(
        "https://api.example.test", httpx.Client(transport=httpx.MockTransport(respond))
    )

    result = client.sign_up("hana@example.com", "correct-password", "Hana")

    assert result.session is None
    assert result.email_confirmation_required is True


def test_list_organizations_uses_bearer_session_and_parses_the_initial_organization() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/organizations"
        assert request.headers["Authorization"] == "Bearer access-token"
        return httpx.Response(
            200,
            json=[
                {
                    "id": str(ORGANIZATION_ID),
                    "name": "Hana Studio",
                    "slug": "hana-studio",
                    "role": "owner",
                }
            ],
        )

    client = ApiClient(
        "https://api.example.test", httpx.Client(transport=httpx.MockTransport(respond))
    )
    session = Session("access-token", "refresh-token", USER_ID)

    assert client.list_organizations(session) == [
        Organization(ORGANIZATION_ID, "Hana Studio", "hana-studio", "owner")
    ]
