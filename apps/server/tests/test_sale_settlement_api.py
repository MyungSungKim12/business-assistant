import asyncio
from datetime import date
from uuid import uuid4

import httpx
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.sale_settlement import get_sale_settlement_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_document_api import ORGANIZATION_ID, FakeAuthAdapter, FakeOrganizationRepository

DAY = date(2026, 10, 8)
OP = uuid4()
SETTLEMENT = {
    "organization_id": str(ORGANIZATION_ID),
    "business_date": DAY.isoformat(),
    "cash_received": "120",
    "cash_refunded": "20",
    "expected_cash": "100",
    "card_received": "300",
    "card_refunded": "0",
    "transfer_received": "0",
    "transfer_refunded": "0",
    "receipt_count": 2,
    "refund_count": 1,
    "receivables": [],
    "is_closed": False,
    "close": None,
}


class Repo:
    def __init__(self):
        self.calls = []

    async def get_daily_settlement(self, *args):
        self.calls.append(("get", *args))
        return SETTLEMENT

    async def close_day(self, *args):
        self.calls.append(("close", *args))
        return SETTLEMENT

    async def adjust_close(self, *args):
        self.calls.append(("adjust", *args))
        return SETTLEMENT


def send(method="GET", suffix="", body=None, role="owner", features=None, repo=None):
    repo = repo or Repo()

    async def run():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["finance.basic"] if features is None else features, role
        )
        app.dependency_overrides[get_sale_settlement_repository] = lambda: repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}/sale-daily-settlement{suffix}",
                headers={"Authorization": "Bearer owner-token"},
                json=body,
            )

    return asyncio.run(run()), repo


def test_read_passes_organization_and_business_date():
    response, repo = send(suffix=f"?business_date={DAY}")
    assert response.status_code == 200
    assert repo.calls == [("get", ORGANIZATION_ID, DAY)]


def test_close_and_adjust_pass_operation_identity_and_version():
    response, repo = send(
        "POST",
        f"/close?business_date={DAY}",
        {"operation_id": str(OP), "counted_cash": "100", "reason": "시재 확인", "confirmed": True},
    )
    assert response.status_code == 200
    assert repo.calls == [("close", ORGANIZATION_ID, DAY, "100", "시재 확인", OP, True)]

    response, repo = send(
        "POST",
        f"/adjustments?business_date={DAY}",
        {
            "operation_id": str(OP),
            "expected_version": 3,
            "counted_cash": "90",
            "reason": "재확인",
            "confirmed": True,
        },
    )
    assert response.status_code == 200
    assert repo.calls[0][0:4] == ("adjust", ORGANIZATION_ID, DAY, 3)


def test_member_can_read_but_cannot_close_and_missing_feature_is_denied():
    assert send(suffix=f"?business_date={DAY}", role="member")[0].status_code == 200
    response, repo = send(
        "POST",
        f"/close?business_date={DAY}",
        {"operation_id": str(OP), "counted_cash": "100", "reason": "마감", "confirmed": True},
        role="member",
    )
    assert response.status_code == 403
    assert not repo.calls
    assert send(suffix=f"?business_date={DAY}", features=[])[0].status_code == 403


def test_invalid_close_requests_do_not_reach_repository():
    for body in [
        {"operation_id": str(OP), "counted_cash": "1.5", "reason": "확인", "confirmed": True},
        {"operation_id": str(OP), "counted_cash": "0", "reason": "  ", "confirmed": True},
        {"operation_id": str(OP), "counted_cash": "10", "reason": "확인", "confirmed": False},
    ]:
        response, repo = send("POST", f"/close?business_date={DAY}", body)
        assert response.status_code == 422
        assert not repo.calls
