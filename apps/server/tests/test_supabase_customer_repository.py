import asyncio
import json
from uuid import UUID

import httpx
import pytest
from business_assistant_server.adapters.supabase_customers import SupabaseCustomerRepository
from business_assistant_server.ports.repositories import RepositoryUnavailableError

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER_ID = UUID("33333333-3333-3333-3333-333333333333")


def test_customer_adapter_uses_tenant_token_and_organization_scope_for_crud() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[_row()])
        if request.method == "POST":
            return httpx.Response(201, json=[_row()])
        if request.method == "PATCH":
            return httpx.Response(200, json=[_row(phone="010-0000-0000")])
        if request.method == "DELETE":
            return httpx.Response(200, json=[_row()])
        raise AssertionError(f"Unexpected request: {request.url}")

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            repository = SupabaseCustomerRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            assert len(await repository.list_customers(ORGANIZATION_ID)) == 1
            await repository.create_customer(
                ORGANIZATION_ID, "Hana Kim", "hana@example.com", None, "Priority"
            )
            await repository.update_customer(
                ORGANIZATION_ID, CUSTOMER_ID, {"phone": "010-0000-0000"}
            )
            assert await repository.delete_customer(ORGANIZATION_ID, CUSTOMER_ID) is True

    asyncio.run(run())

    assert all(request.headers["authorization"] == "Bearer user-token" for request in requests)
    assert all(request.headers["apikey"] == "publishable-key" for request in requests)
    assert all(request.url.path == "/rest/v1/customers" for request in requests)
    assert requests[0].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert requests[2].url.params["id"] == f"eq.{CUSTOMER_ID}"
    assert requests[3].url.params["organization_id"] == f"eq.{ORGANIZATION_ID}"
    assert json.loads(requests[1].content)["organization_id"] == str(ORGANIZATION_ID)
    assert json.loads(requests[2].content) == {"phone": "010-0000-0000"}


def test_customer_adapter_maps_provider_and_malformed_responses_safely() -> None:
    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(500, text="provider secret")
            )
        ) as client:
            repository = SupabaseCustomerRepository(
                "https://project.supabase.co", "publishable-key", "user-token", client
            )
            with pytest.raises(
                RepositoryUnavailableError, match="Organization service unavailable"
            ):
                await repository.list_customers(ORGANIZATION_ID)

    asyncio.run(run())


def _row(phone: str | None = "010-1234-5678") -> dict[str, str | None]:
    return {
        "id": str(CUSTOMER_ID),
        "organization_id": str(ORGANIZATION_ID),
        "name": "Hana Kim",
        "email": "hana@example.com",
        "phone": phone,
        "notes": "Priority",
    }
