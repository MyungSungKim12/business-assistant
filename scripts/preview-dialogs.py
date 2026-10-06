"""Capture modal flows with isolated fixtures; no server or account access."""

import importlib
import sys
from pathlib import Path

from business_assistant_desktop.app import create_application
from PySide6.QtTest import QTest

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "apps/desktop/tests"))
app = create_application()


class PreviewHost:
    def addWidget(self, widget):
        self.widget = widget

    def waitUntil(self, predicate):
        for _ in range(100):
            if predicate():
                return
            QTest.qWait(20)
        raise RuntimeError("Preview fixture did not finish")


host = PreviewHost()
for name, factory in (
    ("consultation", "dialog"),
    ("document_consent", "setup"),
    ("document_issuance", "setup"),
    ("sales_draft", "setup"),
):
    module = importlib.import_module(f"test_{name}_dialog")
    dialog, _ = getattr(module, factory)(host)
    dialog.setWindowTitle(dialog.windowTitle() + " · 데모 데이터")
    dialog.show()
    app.processEvents()
    dialog.grab().save(str(root / f"docs/screenshots/remodel-{name}.png"))
    dialog.hide()
