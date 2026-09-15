from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class AuthUser:
    user_id: UUID
    email: str
    display_name: str | None


@dataclass(frozen=True, slots=True)
class AuthSession:
    user: AuthUser
    access_token: str
    refresh_token: str | None
