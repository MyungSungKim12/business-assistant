from uuid import UUID

import pytest
from business_assistant_common.auth import AuthSession, AuthUser
from business_assistant_common.entitlements import EntitlementSet


def test_auth_session_retains_immutable_user_and_tokens() -> None:
    user = AuthUser(
        user_id=UUID("12345678-1234-5678-1234-567812345678"),
        email="hana@example.com",
        display_name=None,
    )
    session = AuthSession(user=user, access_token="access-token", refresh_token="refresh-token")

    assert session.user == user
    assert session.access_token == "access-token"
    assert session.refresh_token == "refresh-token"
    with pytest.raises(AttributeError):
        session.access_token = "replacement-token"  # type: ignore[misc]


def test_entitlement_set_serializes_features_in_sorted_order() -> None:
    entitlements = EntitlementSet(frozenset({"crm.basic", "analytics.basic", "dashboard.basic"}))

    assert entitlements.serialize() == ["analytics.basic", "crm.basic", "dashboard.basic"]
