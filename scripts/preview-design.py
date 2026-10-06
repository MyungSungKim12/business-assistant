"""Render secondary pages with isolated test fixtures, never a live account.

Run with QT_QPA_PLATFORM=offscreen. PREVIEW_WIDTH/HEIGHT/SCALE configure capture.
"""

import os
import runpy
from pathlib import Path
from uuid import UUID

from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.app import create_application
from business_assistant_desktop.document_page import DocumentPage
from business_assistant_desktop.file_page import FilePage
from business_assistant_desktop.finance_page import FinancePage
from business_assistant_desktop.login_dialog import LoginDialog
from business_assistant_desktop.main_window import MainWindow
from business_assistant_desktop.sale_cart_page import SaleCartWorkspace
from business_assistant_desktop.task_page import TaskPage

root = Path(__file__).resolve().parents[1]
destination = root / "docs/screenshots"
destination.mkdir(exist_ok=True)
app = create_application()
window = MainWindow(
    EntitlementSet(
        frozenset(
            {
                "schedule.basic",
                "document.template",
                "finance.basic",
                "files.basic",
            }
        )
    )
)
window.setWindowTitle("디자인 검증 · 데모 데이터")
width = int(os.environ.get("PREVIEW_WIDTH", "1440"))
height = int(os.environ.get("PREVIEW_HEIGHT", "920"))
window.resize(width, height)
window.show()
for key, module, cls, fixture in (
    ("schedule", "task", TaskPage, "FakeTaskClient"),
    ("documents", "document", DocumentPage, "FakeDocumentClient"),
    ("finance", "finance", FinancePage, "FakeFinanceClient"),
    ("files", "file", FilePage, "FakeFileClient"),
):
    data = runpy.run_path(str(root / f"apps/desktop/tests/test_{module}_page.py"))
    page = cls(data[fixture](), UUID("11111111-1111-1111-1111-111111111111"))
    index = window._page_by_key[key]
    old = window.pages.widget(index)
    window.pages.removeWidget(old)
    old.deleteLater()
    window.pages.insertWidget(index, page)
    window.navigation_menu.setCurrentRow(index)
    app.processEvents()
    window.grab().save(str(destination / f"remodel-{key}-{width}.png"))
sale_data = runpy.run_path(str(root / "apps/desktop/tests/test_sale_cart_page.py"))
sale_cart = SaleCartWorkspace(
    sale_data["Client"](),
    UUID("11111111-1111-1111-1111-111111111111"),
    can_manage=True,
)
sale_cart.show()
for _ in range(100):
    app.processEvents()
    if not sale_cart.busy:
        break
sale_cart.grab().save(str(destination / f"remodel-sale-cart-{width}.png"))
sale_cart.close()
login = LoginDialog(object(), lambda _: None)
login.show()
app.processEvents()
login.grab().save(str(destination / "remodel-login.png"))
