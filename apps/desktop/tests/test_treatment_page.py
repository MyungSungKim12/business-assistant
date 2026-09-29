from dataclasses import replace
from decimal import Decimal
from threading import Event
from uuid import uuid4

from business_assistant_desktop.api_client import Customer, Treatment
from business_assistant_desktop.treatment_page import TreatmentPage
from PySide6.QtWidgets import QMessageBox

ORG = uuid4()


class Client:
    def __init__(self):
        self.customers = [
            Customer(
                uuid4(), "이지은", phone="010-1234-5678", allergies="향료 주의", skin_type="건성"
            ),
            Customer(uuid4(), "김민지"),
        ]
        self.records = [
            Treatment(
                uuid4(),
                self.customers[0].id,
                "2026-09-18",
                "수분 관리",
                "피부",
                "김담당",
                "기록",
                Decimal("15000.50"),
                None,
            )
        ]
        self.saves = []
        self.fail = False

    def list_customers(self, org):
        return self.customers

    def list_treatments(self, org, customer):
        return [r for r in self.records if r.customer_id == customer]

    def create_treatment(self, org, customer, values):
        if self.fail:
            raise RuntimeError("offline")
        self.saves.append(values)
        values = dict(
            values, amount=Decimal(values["amount"]) if values["amount"] is not None else None
        )
        record = Treatment(id=uuid4(), customer_id=customer, **values)
        self.records.append(record)
        return record

    def mutate_treatment(self, org, customer, record_id, payload):
        return self.update_treatment(org, customer, record_id, payload["values"])

    def update_treatment(self, org, customer, record_id, values):
        if self.fail:
            raise RuntimeError("offline")
        self.saves.append(values)
        old = next(r for r in self.records if r.id == record_id)
        values = dict(
            values, amount=Decimal(values["amount"]) if values["amount"] is not None else None
        )
        record = replace(old, **values)
        self.records[self.records.index(old)] = record
        return record


def page(qtbot, client=None, **kw):
    client = client or Client()
    w = TreatmentPage(client, ORG, **kw)
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: not w.is_loading)
    return w, client


def test_load_shows_real_customer_history_and_cautions(qtbot):
    w, c = page(qtbot)
    assert w.customer_list.count() == 2
    assert w.history_table.rowCount() == 1
    assert "향료" in w.cautions.text()
    assert "수분 관리" in w.history_table.item(0, 1).text()


def test_register_edit_and_copy_preserve_original(qtbot):
    w, c = page(qtbot)
    w.form.name_input.setText("진정 관리")
    w.form.amount_input.setText("1234.50")
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert len(c.records) == 2
    assert c.saves[0]["amount"] == "1234.50"
    saved_id = w.selected_record_id
    w.form.notes_input.setPlainText("수정 기록")
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert len(c.records) == 2
    assert w.selected_record_id == saved_id
    w._copy_record()
    assert w.selected_record_id is None
    assert w.form.name_input.text() == "진정 관리"
    assert w.has_unsaved_changes()
    assert c.records[-1].notes == "수정 기록"


def test_validation_and_failed_save_keep_input(qtbot):
    w, c = page(qtbot)
    w.form.name_input.setText("   ")
    w._save()
    assert c.saves == []
    w.form.name_input.setText("피부 관리")
    w.form.amount_input.setText("-1")
    w._save()
    assert c.saves == []
    w.form.amount_input.setText("100")
    c.fail = True
    w._save()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert "실패" in w.status_label.text()
    assert w.form.name_input.text() == "피부 관리"
    assert w.has_unsaved_changes()


def test_dirty_customer_switch_cancel(qtbot, monkeypatch):
    w, c = page(qtbot)
    w.form.name_input.setText("작성중")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    w.open_customer(c.customers[1].id)
    assert w.selected_customer_id == c.customers[0].id
    assert w.form.name_input.text() == "작성중"


def test_readonly_cannot_create_or_update(qtbot):
    w, c = page(qtbot, can_manage=False)
    w.form.name_input.setText("수정")
    w._save()
    assert c.saves == []
    assert not w.save_button.isEnabled()
    assert w.form.name_input.isReadOnly()


def test_late_customer_result_is_ignored(qtbot):
    gate = Event()

    class Slow(Client):
        def list_treatments(self, org, customer):
            if customer == self.customers[0].id:
                gate.wait(2)
            return super().list_treatments(org, customer)

    c = Slow()
    w = TreatmentPage(c, ORG)
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: w.customer_list.count() == 2)
    w.open_customer(c.customers[1].id)
    qtbot.waitUntil(lambda: not w.is_loading)
    gate.set()
    qtbot.waitUntil(lambda: not w._workers)
    assert w.selected_customer_id == c.customers[1].id
    assert w.history_table.rowCount() == 0


def test_history_filters_and_invalid_date_range(qtbot):
    w, c = page(qtbot)
    w.record_search.setText("없는 시술")
    assert w.history_table.isRowHidden(0)
    w.record_search.clear()
    assert not w.history_table.isRowHidden(0)
    w.date_from.setText("2026-02-31")
    assert "날짜" in w.filter_status.text()


def test_duplicate_save_and_navigation_while_saving(qtbot):
    gate = Event()

    class Slow(Client):
        def create_treatment(self, *args):
            gate.wait(2)
            return super().create_treatment(*args)

    w, c = page(qtbot, Slow())
    w.form.name_input.setText("새 기록")
    w._save()
    w._save()
    assert not w.confirm_leave()
    assert not w.open_customer(c.customers[1].id)
    gate.set()
    qtbot.waitUntil(lambda: not w.is_saving)
    assert len(c.saves) == 1


def test_history_failure_retry_and_no_phone_search(qtbot):
    class Broken(Client):
        broken = True

        def list_treatments(self, *args):
            if self.broken:
                raise RuntimeError("offline")
            return super().list_treatments(*args)

    w, c = page(qtbot, Broken())
    assert "조회 실패" in w.status_label.text()
    c.broken = False
    w._reload()
    qtbot.waitUntil(lambda: not w.is_loading)
    assert w.history_table.rowCount() == 1
    w.customer_search.setText("김민지")
    assert not w.customer_list.item(1).isHidden()


def test_save_choice_then_customer_switch(qtbot, monkeypatch):
    w, c = page(qtbot)
    w.form.name_input.setText("저장하고 이동")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Save)
    assert not w.open_customer(c.customers[1].id)
    qtbot.waitUntil(lambda: not w.is_saving)
    assert w.open_customer(c.customers[1].id)
    qtbot.waitUntil(lambda: not w.is_loading)
    assert c.records[-1].treatment_name == "저장하고 이동"


def test_menu_navigation_close_and_customer_shortcut(qtbot, monkeypatch):
    from business_assistant_common.entitlements import EntitlementSet
    from business_assistant_desktop.main_window import MainWindow
    from PySide6.QtGui import QCloseEvent

    w, c = page(qtbot)
    window = MainWindow(EntitlementSet(frozenset({"crm.basic"})))
    qtbot.addWidget(window)
    index = window._page_by_key["treatments"]
    old = window.pages.widget(index)
    window.pages.removeWidget(old)
    window.pages.insertWidget(index, w)
    window._open_treatments(c.customers[1].id)
    qtbot.waitUntil(lambda: not w.is_loading)
    assert window.pages.currentWidget() is w
    assert w.selected_customer_id == c.customers[1].id
    w.form.name_input.setText("작성 중")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    window.navigation_menu.setCurrentRow(0)
    assert window.pages.currentWidget() is w
    event = QCloseEvent()
    window.closeEvent(event)
    assert not event.isAccepted()
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Discard
    )
    window.navigation_menu.setCurrentRow(0)
    assert window.pages.currentIndex() == 0
    assert not w.has_unsaved_changes()


def test_bound_treatment_client_preserves_session():
    from types import SimpleNamespace

    from business_assistant_desktop.main_window import _BoundTreatmentClient

    calls = []
    session = object()

    def capture(*args):
        calls.append(args)

    bound = _BoundTreatmentClient(
        SimpleNamespace(
            list_treatments=capture, create_treatment=capture, update_treatment=capture
        ),
        session,
    )
    customer_id, record_id = uuid4(), uuid4()
    bound.list_treatments(ORG, customer_id)
    bound.create_treatment(ORG, customer_id, {"notes": "내용"})
    bound.update_treatment(ORG, customer_id, record_id, {"notes": "수정"})
    assert all(args[:3] == (ORG, session, customer_id) for args in calls)
    assert calls[-1][3] == record_id


def test_shortcut_refreshes_customers_created_after_page_load(qtbot):
    w, c = page(qtbot)
    customer = Customer(uuid4(), "신규 고객")
    c.customers = c.customers + [customer]
    assert w.open_customer(customer.id)
    qtbot.waitUntil(lambda: not w.is_loading)
    assert w.selected_customer_id == customer.id
