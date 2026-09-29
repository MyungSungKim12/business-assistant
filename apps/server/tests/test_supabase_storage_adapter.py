import asyncio

import httpx
from business_assistant_server.adapters.supabase_files import SupabaseStorageAdapter


def test_signed_upload_response_uses_url_field() -> None:
    async def run() -> str:
        async def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path.endswith("/object/upload/sign/business-files/org/photo.png")
            return httpx.Response(
                200,
                json={"url": "/object/upload/sign/business-files/org/photo.png?token=test"},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            adapter = SupabaseStorageAdapter("https://project.supabase.co", "key", "token", client)
            return await adapter.create_upload_url("business-files", "org/photo.png")
        finally:
            await client.aclose()

    assert asyncio.run(run()) == (
        "https://project.supabase.co/storage/v1/object/upload/sign/"
        "business-files/org/photo.png?token=test"
    )


def test_signed_download_response_uses_signed_url_field() -> None:
    async def run() -> str:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"signedURL": "/object/sign/business-files/org/photo.png?token=test"},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            adapter = SupabaseStorageAdapter("https://project.supabase.co", "key", "token", client)
            return await adapter.create_download_url("business-files", "org/photo.png", 300)
        finally:
            await client.aclose()

    assert asyncio.run(run()) == (
        "https://project.supabase.co/storage/v1/object/sign/business-files/org/photo.png?token=test"
    )
