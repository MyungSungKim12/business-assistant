import asyncio

import httpx
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.api.management import get_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from test_document_api import ORGANIZATION_ID, FakeAuthAdapter, FakeOrganizationRepository


class Repo:
    async def get_preview(self, organization_id, from_date, to_date):
        return {
            "organization_id": str(organization_id),
            "from_date": from_date.isoformat(),
            "to_date": to_date.isoformat(),
            "recorded_income": "100",
            "recorded_expense": "20",
            "recorded_net": "80",
            "transaction_count": 2,
            "visit_receipts": "100",
            "visit_refunds": "0",
            "staff_sales_basis": [],
            "is_final_profit": False,
            "excluded_costs": ["inventory_cogs"],
            "staff_basis_is_commission": False,
        }


def send(role="owner", features=None, period="from_date=2026-10-01&to_date=2026-10-08"):
    async def run():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["finance.basic"] if features is None else features, role
        )
        app.dependency_overrides[get_repository] = Repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.get(
                f"/api/v1/organizations/{ORGANIZATION_ID}/management-preview?{period}",
                headers={"Authorization": "Bearer owner-token"},
            )

    return asyncio.run(run())


def test_manager_gets_explicit_incomplete_preview():
    result = send()
    assert result.status_code == 200
    assert result.json()["recorded_net"] == "80"
    assert result.json()["is_final_profit"] is False


def test_member_other_role_feature_and_period_are_rejected():
    assert send(role="member").status_code == 403
    assert send(role="outsider").status_code == 403
    assert send(features=[]).status_code == 403
    assert send(period="from_date=2026-11-01&to_date=2026-10-01").status_code == 422
    assert send(period="from_date=2026-01-01&to_date=2027-12-31").status_code == 422
