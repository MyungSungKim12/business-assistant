from business_assistant_desktop.dashboard_page import DashboardPage


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
