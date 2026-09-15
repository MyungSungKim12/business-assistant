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


@dataclass(frozen=True, slots=True)
class AuthSignUpResult:
    """The result of a signup, with or without an immediately usable session."""

    session: AuthSession | None
    email_confirmation_required: bool
