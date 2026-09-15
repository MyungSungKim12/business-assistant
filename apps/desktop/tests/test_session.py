from uuid import UUID

from business_assistant_desktop.session import Session


def test_session_keeps_authenticated_user_tokens_in_memory() -> None:
    user_id = UUID("12345678-1234-5678-1234-567812345678")

    session = Session("access-token", "refresh-token", user_id)

    assert session.access_token == "access-token"
    assert session.refresh_token == "refresh-token"
    assert session.user_id == user_id
