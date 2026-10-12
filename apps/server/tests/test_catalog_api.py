import asyncio
from uuid import uuid4

import httpx
import pytest
from business_assistant_server.api.catalog import get_catalog_repository
from business_assistant_server.api.entitlements import get_organization_repository
from business_assistant_server.dependencies.auth import get_auth_adapter
from business_assistant_server.main import create_app
from business_assistant_server.ports.repositories import RepositoryConflictError
from test_document_api import ORGANIZATION_ID, FakeAuthAdapter, FakeOrganizationRepository

PRODUCT = uuid4()
OP = uuid4()
VALUES = dict(
    sku="SKU-1",
    name="보습 크림",
    kind="product",
    unit_name="개",
    sale_price="30000",
    benefit_money="0",
    benefit_count=0,
    valid_days=None,
    is_active=True,
)
ROW = dict(
    id=str(PRODUCT), organization_id=str(ORGANIZATION_ID), **VALUES, version=1, stock_quantity=0
)


class Repo:
    def __init__(self):
        self.calls = []
        self.error = None

    async def list_products(self, *args):
        self.calls.append(args)
        return [ROW]

    async def save_product(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return ROW

    async def receive_stock(self, *args):
        self.calls.append(args)
        return ROW

    async def change_stock(self, *args):
        self.calls.append(args)
        return ROW

    async def list_stock_ledger(self, *args):
        self.calls.append(args)
        return []

    async def list_wallets(self, *args):
        self.calls.append(args)
        return []

    async def manage_wallet(self, *args):
        self.calls.append(args)
        return dict(
            id=str(args[2]),
            organization_id=str(args[0]),
            customer_id=str(args[1]),
            product_id=str(PRODUCT),
            sale_line_id=str(uuid4()),
            name_snapshot="회원권",
            money_balance="100",
            count_balance=1,
            valid_from="2026-10-01",
            expires_on="2026-12-31",
            source_snapshot={},
            created_at="2026-10-01T00:00:00Z",
            lifecycle_status="paused" if args[3] == "pause" else "active",
            lifecycle_version=args[6] + 1,
        )

    async def add_product(self, *args):
        from test_sale_cart_api import bundle

        self.calls.append(args)
        return bundle()

    async def use_wallet(self, *args):
        from test_visit_payment_api import RESULT

        self.calls.append(args)
        return {**RESULT, "visit_id": str(args[1])}


def send(method="POST", path="catalog-products", body=None, role="owner", features=None, repo=None):
    repo = repo or Repo()

    async def run():
        app = create_app()
        app.dependency_overrides[get_auth_adapter] = FakeAuthAdapter
        app.dependency_overrides[get_organization_repository] = lambda: FakeOrganizationRepository(
            ["crm.basic", "finance.basic"] if features is None else features, role
        )
        app.dependency_overrides[get_catalog_repository] = lambda: repo
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.request(
                method,
                f"/api/v1/organizations/{ORGANIZATION_ID}/{path}",
                headers={"Authorization": "Bearer owner-token"},
                json=body,
            )

    return asyncio.run(run()), repo


def payload():
    return dict(**VALUES, operation_id=str(OP))


def test_create_passes_scoped_values_and_identity():
    response, repo = send(body=payload())
    assert response.status_code == 201
    assert repo.calls == [(ORGANIZATION_ID, None, None, OP, VALUES)]


def test_update_passes_expected_version():
    response, repo = send(
        "PUT", f"catalog-products/{PRODUCT}", dict(**payload(), expected_version=1)
    )
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, PRODUCT, 1, OP, VALUES)]


def test_member_reads_but_write_and_missing_features_denied():
    assert send("GET", role="member")[0].status_code == 200
    for role, features in [("member", None), ("owner", []), ("owner", ["finance.basic"])]:
        response, repo = send(body=payload(), role=role, features=features)
        assert response.status_code == 403
        assert not repo.calls


@pytest.mark.parametrize(
    "field,value",
    [
        ("sale_price", "1.5"),
        ("sale_price", 100),
        ("sale_price", "NaN"),
        ("sale_price", "-1"),
        ("sale_price", "0"),
        ("name", "  "),
        ("sku", " "),
        ("is_active", "true"),
        ("benefit_count", True),
        ("valid_days", 0),
        ("benefit_money", "1"),
        ("unexpected", True),
    ],
)
def test_invalid_catalog_never_reaches_repository(field, value):
    body = payload()
    body[field] = value
    response, repo = send(body=body)
    assert response.status_code == 422
    assert not repo.calls


def test_membership_requires_benefit_but_combined_allowed():
    body = dict(**payload())
    body["kind"] = "membership"
    assert send(body=body)[0].status_code == 422
    body.update(benefit_money="50000", benefit_count=3, valid_days=90)
    assert send(body=body)[0].status_code == 201


def test_stock_reason_quantity_and_permissions():
    path = f"catalog-products/{PRODUCT}/stock-receipts"
    body = dict(operation_id=str(OP), quantity=3, reason="신규 입고")
    response, repo = send(path=path, body=body)
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, PRODUCT, 3, "신규 입고", OP)]
    assert send(path=path, body=body, role="member")[0].status_code == 403
    for values in [dict(quantity=0), dict(quantity=True), dict(reason=" ")]:
        assert send(path=path, body={**body, **values})[0].status_code == 422


def test_wallet_list_and_conflict():
    customer = uuid4()
    response, repo = send("GET", f"customers/{customer}/wallets", role="member")
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, customer)]
    repo.error = RepositoryConflictError()
    assert send(body=payload(), repo=repo)[0].status_code == 409


def test_catalog_add_requires_version_and_management():
    from test_sale_cart_api import VISIT_ID

    path = f"visits/{VISIT_ID}/sale-cart/lines/catalog-product"
    body = dict(product_id=str(PRODUCT), expected_version=2, operation_id=str(OP))
    response, repo = send(path=path, body=body)
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, VISIT_ID, PRODUCT, 2, OP)]
    response, repo = send(path=path, body=body, role="member")
    assert response.status_code == 403
    assert not repo.calls
    for version in [None, True, 0, "1"]:
        response, repo = send(path=path, body={**body, "expected_version": version})
        assert response.status_code == 422
        assert not repo.calls


def test_stock_adjustment_requires_expected_version_and_manager():
    path = f"catalog-products/{PRODUCT}/stock-adjustments"
    body = dict(
        operation_id=str(OP),
        kind="supplier_return",
        quantity=2,
        reason="거래처 반품",
        expected_version=4,
    )
    response, repo = send(path=path, body=body)
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, PRODUCT, "supplier_return", 2, "거래처 반품", 4, OP)]
    assert send(path=path, body=body, role="member")[0].status_code == 403
    for change in [
        {"kind": "unknown"},
        {"quantity": 0},
        {"quantity": True},
        {"expected_version": 0},
        {"expected_version": True},
        {"reason": " "},
    ]:
        response, repo = send(path=path, body={**body, **change})
        assert response.status_code == 422
        assert not repo.calls


def test_stocktake_allows_zero_count_only_for_stocktake():
    path = f"catalog-products/{PRODUCT}/stock-adjustments"
    base = dict(operation_id=str(OP), quantity=0, reason="실사", expected_version=4)
    response, repo = send(path=path, body={**base, "kind": "stocktake"})
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, PRODUCT, "stocktake", 0, "실사", 4, OP)]
    response, repo = send(path=path, body={**base, "kind": "disposal"})
    assert response.status_code == 422
    assert not repo.calls
    response, repo = send(path=path, body={**base, "kind": "disposal", "quantity": 1000000})
    assert response.status_code == 422
    assert not repo.calls


def test_stock_ledger_is_readable_by_members_and_scoped_to_product():
    response, repo = send("GET", f"catalog-products/{PRODUCT}/stock-ledger", role="member")
    assert response.status_code == 200
    assert response.json() == []
    assert repo.calls == [(ORGANIZATION_ID, PRODUCT)]


def test_wallet_usage_is_strict_scoped_and_manager_only():
    from test_sale_cart_api import VISIT_ID

    wallet, line = uuid4(), uuid4()
    path = f"visits/{VISIT_ID}/wallet-usages"
    body = dict(
        wallet_id=str(wallet),
        sale_line_id=str(line),
        mode="money",
        amount="30000",
        expected_cart_version=3,
        operation_id=str(OP),
        confirmed=True,
    )
    response, repo = send(path=path, body=body)
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, VISIT_ID, wallet, line, "money", "30000", 3, OP, True)]
    response, repo = send(path=path, body=body, role="member")
    assert response.status_code == 403
    assert not repo.calls
    count = {**body, "mode": "count", "amount": None}
    assert send(path=path, body=count)[0].status_code == 200
    for change in [
        {"amount": "0"},
        {"amount": 1},
        {"confirmed": False},
        {"expected_cart_version": True},
        {"mode": "count", "amount": "1"},
        {"mode": "money", "amount": None},
    ]:
        response, repo = send(path=path, body={**body, **change})
        assert response.status_code == 422
        assert not repo.calls


def test_wallet_lifecycle_requires_manager_reason_and_version():
    customer, wallet = uuid4(), uuid4()
    path = f"customers/{customer}/wallets/{wallet}/lifecycle"
    body = dict(action="pause", reason="고객 요청", expected_version=1, operation_id=str(OP))
    response, repo = send(path=path, body=body)
    assert response.status_code == 200
    assert repo.calls == [(ORGANIZATION_ID, customer, wallet, "pause", None, "고객 요청", 1, OP)]
    assert response.json()["lifecycle_status"] == "paused"
    assert send(path=path, body=body, role="member")[0].status_code == 403
    for change in [
        {"reason": " "},
        {"expected_version": 0},
        {"expected_version": True},
        {"extend_days": 7},
        {"action": "extend", "extend_days": None},
    ]:
        invalid, repository = send(path=path, body={**body, **change})
        assert invalid.status_code == 422
        assert not repository.calls
