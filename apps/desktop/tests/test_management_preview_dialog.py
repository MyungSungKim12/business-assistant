from uuid import UUID

from business_assistant_desktop.management_preview_dialog import ManagementPreviewDialog

ORG = UUID("11111111-1111-1111-1111-111111111111")


class Client:
    def __init__(self):
        self.calls = []

    def get_management_preview(self, organization_id, from_date, to_date):
        self.calls.append((organization_id, from_date, to_date))
        return {
            "recorded_income": "100.25",
            "recorded_expense": "20.00",
            "recorded_net": "80.25",
            "visit_receipts": "90.25",
            "visit_refunds": "10.00",
            "transaction_count": 2,
            "is_final_profit": False,
            "staff_basis_is_commission": False,
            "staff_sales_basis": [
                {"staff_name_snapshot": "담당자", "line_count": 1, "gross_line_total": "100.00"}
            ],
        }


def test_preview_shows_recorded_amounts_without_calling_them_final_profit(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = ManagementPreviewDialog(client, ORG)
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    assert client.calls
    assert "100.25원" in dialog.recorded.text()
    assert "원가" in dialog.warning.text()
    assert dialog.table.item(0, 0).text() == "담당자"
    assert dialog.table.item(0, 3).text() == "수당 미확정"


def test_invalid_period_does_not_call_server(qtbot):  # type: ignore[no-untyped-def]
    client = Client()
    dialog = ManagementPreviewDialog(client, ORG)
    qtbot.addWidget(dialog)
    qtbot.waitUntil(lambda: not dialog.busy)
    before = len(client.calls)
    dialog.from_date.setText("2026-12-31")
    dialog.to_date.setText("2026-01-01")
    dialog.refresh()
    assert len(client.calls) == before
    assert "366일" in dialog.status.text()
