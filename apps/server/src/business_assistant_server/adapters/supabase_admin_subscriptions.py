from uuid import UUID

import httpx

from business_assistant_server.api.admin import (
    AdminSubscriptionInputError,
    AdminSubscriptionRequest,
    AdminSubscriptionUnavailableError,
)


class SupabaseAdminSubscriptionRepository:
    """Server-only subscription writer; never used by tenant adapters."""

    def __init__(self, supabase_url: str, service_key: str) -> None:
        self._url = f"{supabase_url.rstrip('/')}/rest/v1"
        self._service_key = service_key

    async def replace_subscription(
        self, organization_id: UUID, request: AdminSubscriptionRequest
    ) -> AdminSubscriptionRequest:
        headers = {"apikey": self._service_key, "Authorization": f"Bearer {self._service_key}"}
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self._url}/rpc/replace_organization_subscription",
                    json={
                        "target_organization_id": str(organization_id),
                        "target_plan_code": request.plan_code,
                        "target_status": request.status,
                        "target_starts_at": request.starts_at.isoformat(),
                        "target_ends_at": request.ends_at.isoformat() if request.ends_at else None,
                    },
                    headers=headers,
                )
                if response.status_code == 400:
                    raise AdminSubscriptionInputError("Invalid subscription input")
                response.raise_for_status()
                payload = response.json()
        except AdminSubscriptionInputError:
            raise
        except (httpx.HTTPError, ValueError) as error:
            raise AdminSubscriptionUnavailableError() from error
        if not isinstance(payload, dict) or payload.get("plan_code") != request.plan_code:
            raise AdminSubscriptionUnavailableError()
        return request
