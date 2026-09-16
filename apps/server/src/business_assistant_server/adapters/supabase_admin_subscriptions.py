from uuid import UUID

import httpx

from business_assistant_server.api.admin import AdminSubscriptionRequest


class SupabaseAdminSubscriptionRepository:
    """Server-only subscription writer; never used by tenant adapters."""

    def __init__(self, supabase_url: str, service_key: str) -> None:
        self._url = f"{supabase_url.rstrip('/')}/rest/v1"
        self._service_key = service_key

    async def replace_subscription(
        self, organization_id: UUID, request: AdminSubscriptionRequest
    ) -> AdminSubscriptionRequest:
        headers = {"apikey": self._service_key, "Authorization": f"Bearer {self._service_key}"}
        async with httpx.AsyncClient() as client:
            plan = await client.get(
                f"{self._url}/plans",
                params={"select": "id", "code": f"eq.{request.plan_code}"},
                headers=headers,
            )
            plan.raise_for_status()
            rows = plan.json()
            if not isinstance(rows, list) or not rows:
                raise ValueError("Unknown plan code")
            await client.delete(
                f"{self._url}/subscriptions",
                params={
                    "organization_id": f"eq.{organization_id}",
                    "status": "in.(trialing,active)",
                },
                headers=headers,
            )
            created = await client.post(
                f"{self._url}/subscriptions",
                json={
                    "organization_id": str(organization_id),
                    "plan_id": rows[0]["id"],
                    "status": request.status,
                    "starts_at": request.starts_at.isoformat(),
                    "ends_at": request.ends_at.isoformat() if request.ends_at else None,
                },
                headers=headers,
            )
            created.raise_for_status()
        return request
