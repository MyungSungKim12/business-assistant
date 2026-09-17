from decimal import Decimal
from pathlib import Path
from uuid import UUID

import httpx
from business_assistant_desktop.api_client import (
    ApiClient,
    DocumentTemplate,
)
from business_assistant_desktop.session import Session

ORG = UUID("11111111-1111-1111-1111-111111111111")
USER = UUID("22222222-2222-2222-2222-222222222222")
ITEM = UUID("33333333-3333-3333-3333-333333333333")
SESSION = Session("token", None, USER)


def test_task_and_document_methods_use_authenticated_routes() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer token"
        if request.url.path.endswith("/tasks"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(ITEM),
                        "organization_id": str(ORG),
                        "created_by": str(USER),
                        "title": "업무",
                        "description": "설명",
                        "due_at": None,
                        "status": "open",
                        "priority": "normal",
                    }
                ],
            )
        return httpx.Response(
            200,
            json=[
                {
                    "id": str(ITEM),
                    "organization_id": str(ORG),
                    "created_by": str(USER),
                    "name": "템플릿",
                    "description": "",
                    "content": "본문",
                    "is_archived": False,
                    "created_at": "now",
                    "updated_at": "now",
                }
            ],
        )

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    assert api.list_tasks(ORG, SESSION)[0].title == "업무"
    assert api.list_document_templates(ORG, SESSION)[0] == DocumentTemplate(
        ITEM, ORG, USER, "템플릿", "", "본문", False, "now", "now"
    )


def test_finance_and_file_methods_parse_server_payloads(tmp_path: Path) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("finance-transactions"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(ITEM),
                        "organization_id": str(ORG),
                        "created_by": str(USER),
                        "transaction_type": "income",
                        "amount": "1200.00",
                        "transaction_date": "2026-09-17",
                        "category": "판매",
                        "counterparty": "고객",
                        "memo": "",
                        "is_archived": False,
                        "created_at": "now",
                        "updated_at": "now",
                    }
                ],
            )
        if request.url.path.endswith("finance-summary"):
            return httpx.Response(
                200,
                json={
                    "from_date": "2026-09-01",
                    "to_date": None,
                    "income_total": "1200",
                    "expense_total": "0",
                    "net_total": "1200",
                    "transaction_count": 1,
                },
            )
        if request.url.path.endswith("/files"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(ITEM),
                        "organization_id": str(ORG),
                        "uploaded_by": str(USER),
                        "original_name": "a.txt",
                        "content_type": "text/plain",
                        "size_bytes": 3,
                        "is_archived": False,
                        "created_at": "now",
                        "updated_at": "now",
                    }
                ],
            )
        raise AssertionError(request.url)

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    assert api.list_transactions(ORG, SESSION)[0].amount == Decimal("1200.00")
    assert api.get_finance_summary(ORG, SESSION).income_total == Decimal("1200")
    assert api.list_files(ORG, SESSION)[0].original_name == "a.txt"
