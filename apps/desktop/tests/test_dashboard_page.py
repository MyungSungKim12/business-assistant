from datetime import date

import pytest
from business_assistant_desktop.dashboard_page import (
    DashboardPage,
    count_today_appointments,
    total_receivables,
)


def test_partial_failure_does_not_hide_success_and_can_retry(qtbot):
    attempts = []

    def tasks():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("offline")
        return 0

    page = DashboardPage({"crm": lambda: 7, "schedule": tasks}, "매장")
    qtbot.addWidget(page)
    page.open_snapshot()
    qtbot.waitUntil(lambda: not page._workers)
    assert page.values["crm"].text() == "7"
    assert "조회 시각" in page.details["crm"].text()
    assert page.values["schedule"].text() == "—"
    assert "집계 불가" in page.details["schedule"].text()
    assert not page.retry["files"].isEnabled()
    page.refresh("schedule")
    qtbot.waitUntil(lambda: not page._workers)
    assert page.values["schedule"].text() == "0"
    page.open_snapshot()
    assert len(attempts) == 2


def test_no_permission_makes_no_request(qtbot):
    page = DashboardPage({}, "<b>매장</b>")
    qtbot.addWidget(page)
    page.open_snapshot()
    page.refresh("files")
    assert not page._workers
    assert all(value.text() == "—" for value in page.values.values())


def test_live_appointment_and_receivable_metrics_use_valid_business_data(qtbot):
    today = date(2026, 10, 8)
    assert (
        count_today_appointments(
            [
                {"status": "reserved", "start_at": "2026-10-08T00:30:00+09:00"},
                {"status": "confirmed", "start_at": "2026-10-07T16:00:00Z"},
                {"status": "canceled", "start_at": "2026-10-08T10:00:00+09:00"},
            ],
            today,
        )
        == 2
    )
    with pytest.raises(ValueError):
        count_today_appointments([{"status": "reserved", "start_at": "2026-10-08T10:00:00"}], today)
    assert total_receivables({"receivables": [{"due_amount": "10.00"}, {"due_amount": "2"}]}) == 12
    with pytest.raises(ValueError):
        total_receivables({"receivables": [{"due_amount": "NaN"}]})
    page = DashboardPage({"appointments": lambda: 2, "receivables": lambda: 12000}, "매장")
    qtbot.addWidget(page)
    page.open_snapshot()
    qtbot.waitUntil(lambda: not page._workers)
    assert page.values["appointments"].text() == "2"
    assert page.values["receivables"].text() == "12,000원"
