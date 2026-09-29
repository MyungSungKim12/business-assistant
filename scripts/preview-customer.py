"""Render the CRM with isolated example data; no server or account required."""

import os
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.api_client import CustomerActivity
from business_assistant_desktop.app import create_application
from business_assistant_desktop.customer_page import Customer, CustomerPage
from business_assistant_desktop.main_window import MainWindow
from PySide6.QtCore import QTimer


class PreviewClient:
    def __init__(self):
        names = ("이지은", "김민지", "박서연", "최유진", "한지수", "정다은")
        tags = (
            ("피부관리", "LDM", "수분관리"),
            ("얼굴관리", "입술", "리터치"),
            ("아트클래스", "스케일링", "진정관리"),
            ("리프팅", "콜라겐", "고주파"),
            ("스킨부스터", "여드름", "재생관리"),
            ("속눈썹", "눈썹", "영양관리"),
        )
        self.customers = [
            Customer(
                UUID(int=i + 1),
                name,
                phone="010-1234-5678",
                notes="건조하고 예민한 피부, 자극 시 붉음",
                tags=tags[i],
                last_visit_date=f"2026-09-{17 - i:02}",
                birth_date="1996-03-14",
                skin_type="건성",
                concerns=("건조", "민감"),
                allergies="확인 필요",
                next_visit_date="2026-10-01",
            )
            for i, name in enumerate(names)
        ]

        self.activities = {
            customer.id: [
                CustomerActivity(
                    uuid4(),
                    customer.id,
                    "note",
                    "방문 상담",
                    "보습 관리에 관심. 다음 방문 시 상태 확인.",
                    f"2026-09-{17 - i:02}T10:00:00+09:00",
                )
            ]
            for i, customer in enumerate(self.customers)
        }

    def list_customers(self, organization_id):
        return list(self.customers)

    def create_customer_record(self, organization_id, values):
        values = dict(values, tags=tuple(values["tags"]), concerns=tuple(values["concerns"]))
        customer = Customer(id=uuid4(), **values)
        self.customers.append(customer)
        return customer

    def update_customer(self, organization_id, customer_id, values):
        current = next(c for c in self.customers if c.id == customer_id)
        values = dict(values)
        for key in ("tags", "concerns"):
            if key in values:
                values[key] = tuple(values[key])
        customer = replace(current, **values)
        self.customers[self.customers.index(current)] = customer
        return customer

    def list_customer_activities(self, organization_id, customer_id):
        return list(self.activities.get(customer_id, []))

    def create_customer_activity(self, organization_id, customer_id, values):
        activity = CustomerActivity(
            uuid4(), customer_id, occurred_at=datetime.now(UTC).isoformat(), **values
        )
        self.activities.setdefault(customer_id, []).append(activity)
        return activity


if __name__ == "__main__":
    app = create_application()
    if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
        from PySide6.QtGui import QFontDatabase

        for font in ("malgun.ttf", "malgunbd.ttf"):
            QFontDatabase.addApplicationFont(str(Path(os.environ["WINDIR"]) / "Fonts" / font))
    window = MainWindow(
        EntitlementSet(
            frozenset(
                {"crm.basic", "schedule.basic", "document.template", "files.basic", "reports.basic"}
            )
        )
    )
    page = CustomerPage(
        PreviewClient(), UUID(int=99), demo_photos=os.environ.get("PREVIEW_DEMO_PHOTOS") == "1"
    )
    window.setWindowTitle("Business Assistant · 데모 데이터")
    old = window.pages.widget(1)
    window.pages.removeWidget(old)
    window.pages.insertWidget(1, page)
    window.navigation_menu.setCurrentRow(1)
    page._select_customer(page._customers[0])
    window.resize(
        int(os.environ.get("PREVIEW_WIDTH", "1280")), int(os.environ.get("PREVIEW_HEIGHT", "800"))
    )
    window.show()
    app.processEvents()
    if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
        destination = Path(__file__).resolve().parents[1] / "docs" / "screenshots"
        destination.mkdir(exist_ok=True)

        def capture():
            if os.environ.get("PREVIEW_COMPOSER") == "1":
                page.activity_panel._toggle_composer()
                page.activity_panel.title_input.setText("다음 방문 상담")
                page.activity_panel.description_input.setPlainText("고객 요청 사항을 기록합니다.")
                app.processEvents()
            name = os.environ.get("PREVIEW_FILENAME", "customer-workspace.png")
            window.grab().save(str(destination / name))
            page.activity_panel.discard_draft()
            page.info_panel.mark_clean()
            app.quit()

        QTimer.singleShot(250, capture)
        app.exec()
    else:
        app.exec()
