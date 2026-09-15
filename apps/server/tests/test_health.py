import asyncio

import httpx
from business_assistant_server.main import create_app


def test_health_endpoint_is_available_without_supabase() -> None:
    async def request_health() -> httpx.Response:
        transport = httpx.ASGITransport(app=create_app())
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.get("/api/v1/health")

    response = asyncio.run(request_health())

    assert response.status_code == 200
    assert response.json() == {
        "service": "business-assistant-server",
        "status": "ok",
    }
