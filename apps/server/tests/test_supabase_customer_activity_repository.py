import asyncio
from uuid import UUID

import httpx
from business_assistant_server.adapters.supabase_customer_activities import (
    SupabaseCustomerActivityRepository,
)

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER_ID = UUID("33333333-3333-3333-3333-333333333333")
ACTIVITY_ID = UUID("44444444-4444-4444-4444-444444444444")


def _row() -> dict[str, object]:
    return {
        "id": str(ACTIVITY_ID),
        "organization_id": str(ORGANIZATION_ID),
        "customer_id": str(CUSTOMER_ID),
        "activity_type": "note",
        "title": "상담 메모",
        "description": "첫 상담",
        "occurred_at": "2026-09-17T10:00:00Z",
    }


def test_activity_adapter_scopes_customer_and_uses_user_token() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=[_row()])

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repo = SupabaseCustomerActivityRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            activities = await repo.list_activities(ORGANIZATION_ID, CUSTOMER_ID)
            assert activities[0].title == "상담 메모"
            created = await repo.create_activity(
                ORGANIZATION_ID, CUSTOMER_ID, "note", "상담 메모", "첫 상담", "2026-09-17T10:00:00Z"
            )
            assert created.id == ACTIVITY_ID

    asyncio.run(run())
    assert all(r.headers["authorization"] == "Bearer user-token" for r in requests)
    assert requests[0].url.path == "/rest/v1/customer_activities"
    assert requests[0].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert requests[0].url.params["customer_id"] == f"eq.{CUSTOMER_ID}"
