"""Render implemented payment UI with explicit demo fixtures, never live accounts."""

from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from uuid import UUID

from business_assistant_desktop.app import create_application
from business_assistant_desktop.visit_payment_dialog import VisitPaymentDialog
from PySide6.QtCore import QSettings
from PySide6.QtTest import QTest

ORG = UUID("11111111-1111-1111-1111-111111111111")
VISIT = UUID("22222222-2222-2222-2222-222222222222")


class DemoClient:
    def get_visit_payments(self, *args):
        return dict(
            visit_id=str(VISIT),
            cart_id=str(ORG),
            cart_version=4,
            total_amount="100000",
            paid_amount="30000",
            outstanding_amount="70000",
            currency="KRW",
            status="collecting",
            receipts=[
                dict(
                    id=str(ORG),
                    operation_id=str(VISIT),
                    method="cash",
                    amount="30000",
                    reference="디자인 검증용 가상 수납",
                    received_at="2026-10-06T01:30:00Z",
                )
            ],
        )


app = create_application()
with TemporaryDirectory() as directory:
    page = VisitPaymentDialog(
        DemoClient(),
        ORG,
        VISIT,
        can_manage=True,
        recovery_store=QSettings(str(Path(directory) / "demo.ini"), QSettings.Format.IniFormat),
        recovery_identity="isolated-demo",
    )
    page.setWindowTitle("수납 화면 검증 · 가상 데이터")
    page.show()
    deadline = monotonic() + 10
    while page.busy and monotonic() < deadline:
        app.processEvents()
        QTest.qWait(10)
    if page.busy:
        raise RuntimeError("Preview loading timed out")
    destination = Path(__file__).resolve().parents[1] / "docs/screenshots"
    for width in (760, 1000):
        page.resize(width, 650)
        app.processEvents()
        if not page.grab().save(str(destination / f"visit-payments-{width}.png")):
            raise RuntimeError("Screenshot failed")
    page.close()
