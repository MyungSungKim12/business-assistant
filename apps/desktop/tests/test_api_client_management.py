from datetime import date
from uuid import uuid4

import httpx
from business_assistant_desktop.api_client import ApiClient
from business_assistant_desktop.session import Session


def test_management_preview_uses_user_token_and_period():
    organization = uuid4()
    calls = []

    def serve(request):
        calls.append(request)
        return httpx.Response(200, json={"recorded_net": "100"})

    api = ApiClient("https://test", httpx.Client(transport=httpx.MockTransport(serve)))
    result = api.get_management_preview(
        organization, Session("token", None, uuid4()), date(2026, 10, 1), date(2026, 10, 8)
    )
    assert result["recorded_net"] == "100"
    assert calls[0].url.path.endswith(f"/organizations/{organization}/management-preview")
    assert calls[0].url.params["from_date"] == "2026-10-01"
    assert calls[0].url.params["to_date"] == "2026-10-08"
    assert calls[0].headers["Authorization"] == "Bearer token"
