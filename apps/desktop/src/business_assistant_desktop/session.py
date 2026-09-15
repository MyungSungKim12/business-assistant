"""In-memory authentication session for the desktop client."""

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class Session:
    """Tokens and user identity returned by the server after authentication."""

    access_token: str
    refresh_token: str | None
    user_id: UUID
