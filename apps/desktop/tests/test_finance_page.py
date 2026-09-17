from datetime import date
from decimal import Decimal
from uuid import UUID

from business_assistant_desktop.finance_page import FinancePage, FinanceSummary, Transaction

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")
TRANSACTION_ID = UUID("22222222-2222-2222-2222-222222222222")


class FakeFinanceClient:
    def __init__(self) -> None:
        self.filters: list[tuple[UUID, str | None, date | None, date | None]] = []

    def list_transactions(
        self,
        organization_id: UUID,
        transaction_type: str | None,
        from_date: date | None,
        to_date: date | None,
    ) -> list[Transaction]:
        self.filters.append((organization_id, transaction_type, from_date, to_date))
        return [
            Transaction(
                TRANSACTION_ID,
                "income",
                Decimal("120000"),
                date(2026, 9, 3),
                "매출",
            )
        ]

    def get_finance_summary(
        self, organization_id: UUID, from_date: date | None, to_date: date | None
    ) -> FinanceSummary:
        return FinanceSummary(Decimal("120000"), Decimal("20000"), Decimal("100000"), 2)


def test_finance_page_applies_type_and_period_filters_and_shows_totals(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeFinanceClient()
    page = FinancePage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.type_filter.setCurrentIndex(1)
    page.from_date_input.setText("2026-09-01")
    page.to_date_input.setText("2026-09-30")
    client.filters.clear()

    page.refresh()

    assert client.filters == [(ORGANIZATION_ID, "income", date(2026, 9, 1), date(2026, 9, 30))]
    assert page.transaction_table.rowCount() == 1
    assert page.income_total_label.text() == "수입 120,000원"
    assert page.expense_total_label.text() == "지출 20,000원"
    assert page.net_total_label.text() == "순액 100,000원"


def test_finance_page_validates_period_before_request(qtbot) -> None:  # type: ignore[no-untyped-def]
    client = FakeFinanceClient()
    page = FinancePage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page.from_date_input.setText("2026-10-01")
    page.to_date_input.setText("2026-09-01")
    client.filters.clear()

    page.refresh()

    assert client.filters == []
    assert page.status_label.text() == "조회 시작일은 종료일보다 늦을 수 없습니다."


def test_finance_page_reports_empty_error_and_permission_states(qtbot) -> None:  # type: ignore[no-untyped-def]
    class EmptyClient(FakeFinanceClient):
        def list_transactions(
            self,
            organization_id: UUID,
            transaction_type: str | None,
            from_date: date | None,
            to_date: date | None,
        ) -> list[Transaction]:
            return []

    empty_page = FinancePage(EmptyClient(), ORGANIZATION_ID)
    qtbot.addWidget(empty_page)
    empty_page.refresh()
    assert empty_page.status_label.text() == "조회된 거래가 없습니다."

    class FailingClient(FakeFinanceClient):
        def list_transactions(
            self,
            organization_id: UUID,
            transaction_type: str | None,
            from_date: date | None,
            to_date: date | None,
        ) -> list[Transaction]:
            raise RuntimeError("offline")

    failing_page = FinancePage(FailingClient(), ORGANIZATION_ID)
    qtbot.addWidget(failing_page)
    failing_page.refresh()
    assert failing_page.status_label.text() == "재무 내역을 불러오지 못했습니다."

    class ForbiddenClient(FakeFinanceClient):
        def list_transactions(
            self,
            organization_id: UUID,
            transaction_type: str | None,
            from_date: date | None,
            to_date: date | None,
        ) -> list[Transaction]:
            raise PermissionError

    forbidden_page = FinancePage(ForbiddenClient(), ORGANIZATION_ID)
    qtbot.addWidget(forbidden_page)
    forbidden_page.refresh()
    assert forbidden_page.status_label.text() == "재무 접근 권한이 없습니다."
