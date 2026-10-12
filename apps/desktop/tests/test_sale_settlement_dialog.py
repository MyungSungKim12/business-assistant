from datetime import date
from uuid import UUID

from business_assistant_desktop.sale_settlement_dialog import SaleSettlementDialog
from PySide6.QtWidgets import QMessageBox

ORG = UUID("11111111-1111-1111-1111-111111111111")


def settlement(closed=False):
    close = (
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "version": 2,
            "expected_cash": 950,
            "counted_cash": 900,
            "variance": -50,
            "reason": "마감",
            "closed_by": str(ORG),
            "closed_at": "2026-10-08T12:00:00Z",
            "adjustments": [],
        }
        if closed
        else None
    )
    return {
        "organization_id": str(ORG),
        "business_date": date.today().isoformat(),
        "cash_received": 1000,
        "cash_refunded": 50,
        "expected_cash": 950,
        "card_received": 3000,
        "card_refunded": 0,
        "transfer_received": 0,
        "transfer_refunded": 0,
        "receipt_count": 2,
        "refund_count": 1,
        "receivables": [
            {
                "cart_id": "33333333-3333-3333-3333-333333333333",
                "visit_id": "44444444-4444-4444-4444-444444444444",
                "customer_id": "55555555-5555-5555-5555-555555555555",
                "customer_name": "김고객",
                "total_amount": 5000,
                "received_amount": 3000,
                "refunded_amount": 0,
                "due_amount": 2000,
            }
        ],
        "is_closed": closed,
        "close": close,
    }


class Client:
    def __init__(self, *, closed=False):
        self.closed = closed
        self.calls = []

    def get_sale_daily_settlement(self, organization_id, business_date):
        self.calls.append(("get", organization_id, business_date))
        return settlement(self.closed)

    def close_sale_day(self, organization_id, business_date, payload):
        self.calls.append(("close", organization_id, business_date, payload))
        self.closed = True
        return settlement(True)

    def adjust_sale_day_close(self, organization_id, business_date, payload):
        self.calls.append(("adjust", organization_id, business_date, payload))
        return settlement(True)


def test_dialog_displays_totals_and_receivables(qtbot):
    client = Client()
    dialog = SaleSettlementDialog(client, ORG, can_manage=True)
    qtbot.addWidget(dialog)
    assert "1,000원" in dialog.cash_label.text()
    assert dialog.expected_label.text() == "950원"
    assert dialog.receivables_table.rowCount() == 1
    assert dialog.receivables_table.item(0, 0).text() == "김고객"
    assert dialog.receivables_table.item(0, 3).text() == "2,000원"


def test_dialog_closes_and_preserves_reason_and_operation_id(qtbot, monkeypatch):
    client = Client()
    dialog = SaleSettlementDialog(client, ORG, can_manage=True)
    qtbot.addWidget(dialog)
    monkeypatch.setattr(
        QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes
    )
    dialog.counted_cash_input.setText("950")
    dialog.reason_input.setText("시재 확인")
    dialog._save_close()
    call = next(call for call in client.calls if call[0] == "close")
    assert call[3]["counted_cash"] == "950"
    assert call[3]["reason"] == "시재 확인"
    assert call[3]["confirmed"] is True
    assert len(call[3]["operation_id"]) == 36


def test_closed_day_uses_versioned_adjustment_and_read_only_role_cannot_save(qtbot, monkeypatch):
    client = Client(closed=True)
    dialog = SaleSettlementDialog(client, ORG, can_manage=True)
    qtbot.addWidget(dialog)
    monkeypatch.setattr(
        QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes
    )
    dialog.counted_cash_input.setText("925")
    dialog.reason_input.setText("영수증 재확인")
    dialog._save_close()
    call = next(call for call in client.calls if call[0] == "adjust")
    assert call[3]["expected_version"] == 2
    assert call[3]["counted_cash"] == "925"

    read_only = SaleSettlementDialog(Client(), ORG, can_manage=False)
    qtbot.addWidget(read_only)
    assert not read_only.save_button.isEnabled()
