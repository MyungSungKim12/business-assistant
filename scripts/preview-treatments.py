"""Preview treatment management using isolated demonstration data."""

import os
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.api_client import Customer, Treatment
from business_assistant_desktop.app import create_application
from business_assistant_desktop.main_window import MainWindow
from business_assistant_desktop.treatment_page import TreatmentPage
from PySide6.QtCore import QTimer
from PySide6.QtGui import QFontDatabase


class PreviewClient:
    def list_customers(self, organization_id):
        return [
            Customer(
                UUID(int=i + 1),
                name,
                phone=f"010-1234-{5678 + i}",
                skin_type="건성",
                allergies="향료에 민감 · 사용 제품 확인",
            )
            for i, name in enumerate(("이지은", "김민지", "박서연", "최유진", "한지수", "정다은"))
        ]

    def list_treatments(self, organization_id, customer_id):
        return [
            Treatment(
                UUID(int=100 + i),
                customer_id,
                f"2026-09-{18 - i * 3:02}",
                name,
                "피부 관리",
                "김서연",
                "보습 중심으로 진행.\n사용 제품과 고객 반응을 확인했습니다.\n"
                "다음 방문 시 피부 상태 재확인.",
                Decimal("80000"),
                "2026-10-01",
                status=("completed", "in_progress", "draft", "legacy")[i],
                version=(3, 2, 1, 1)[i],
                started_at="2026-09-18T02:00:00Z" if i < 2 else None,
                ended_at="2026-09-18T03:00:00Z" if i == 0 else None,
            )
            for i, name in enumerate(
                ("LDM 수분 관리", "진정 · 장벽 관리", "수분 집중 케어", "첫 방문 피부 상담")
            )
        ]


app = create_application()
if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
    for font in ("malgun.ttf", "malgunbd.ttf"):
        QFontDatabase.addApplicationFont(str(Path(os.environ["WINDIR"]) / "Fonts" / font))
window = MainWindow(
    EntitlementSet(
        frozenset(
            {"crm.basic", "schedule.basic", "document.template", "files.basic", "reports.basic"}
        )
    )
)
page = TreatmentPage(PreviewClient(), UUID(int=99))
index = window._page_by_key["treatments"]
old = window.pages.widget(index)
window.pages.removeWidget(old)
window.pages.insertWidget(index, page)
window.navigation_menu.setCurrentRow(index)
window.setWindowTitle("시술관리 · 데모 데이터")
window.resize(
    int(os.environ.get("PREVIEW_WIDTH", "1280")), int(os.environ.get("PREVIEW_HEIGHT", "800"))
)
window.show()


def capture():
    if page.is_loading:
        QTimer.singleShot(100, capture)
        return
    page.history_table.setCurrentCell(0, 0)
    if os.environ.get("PREVIEW_CORRECTION") == "1":
        page._begin_correction()
        page.lifecycle.reason_input.setText("사용 제품 기록 누락 보완")
    page.status_label.setText("화면 검증용 데모 데이터 · 실제 고객 정보가 아닙니다.")
    app.processEvents()
    destination = Path(__file__).resolve().parents[1] / "docs/screenshots"
    destination.mkdir(exist_ok=True)
    window.grab().save(
        str(destination / os.environ.get("PREVIEW_FILENAME", "treatment-workspace.png"))
    )
    page._clear_correction()
    page.form.mark_clean()
    app.quit()


if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
    QTimer.singleShot(250, capture)
app.exec()
