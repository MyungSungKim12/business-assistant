from typing import Protocol, runtime_checkable


@runtime_checkable
class AuthPort(Protocol):
    async def verify_access_token(self, access_token: str) -> str:
        """Return the authenticated Supabase user UUID as text."""
        ...
