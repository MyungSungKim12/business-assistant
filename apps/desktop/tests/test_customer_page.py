"""CRM interaction tests use server-shaped records, including profile arrays."""

from dataclasses import replace
from threading import Event
from uuid import UUID, uuid4

from business_assistant_desktop.api_client import Customer
from business_assistant_desktop.customer_page import CustomerPage
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMessageBox

ORGANIZATION_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeClient:
    def __init__(self):
        self.customers = [Customer(uuid4(), "김고객", "kim@example.com", "010-1234-5678", "메모")]
        self.created_values = []
        self.updated_values = []
        self.fail_save = False

    def list_customers(self, organization_id):
        return list(self.customers)

    def create_customer_record(self, organization_id, values):
        if self.fail_save:
            raise RuntimeError("offline")
        self.created_values.append(values)
        converted = dict(values, tags=tuple(values["tags"]), concerns=tuple(values["concerns"]))
        customer = Customer(id=uuid4(), **converted)
        self.customers.append(customer)
        return customer

    def update_customer(self, organization_id, customer_id, values):
        if self.fail_save:
            raise RuntimeError("offline")
        self.updated_values.append(values)
        current = next(item for item in self.customers if item.id == customer_id)
        converted = dict(values)
        for key in ("tags", "concerns"):
            if key in converted:
                converted[key] = tuple(converted[key])
        updated = replace(current, **converted)
        self.customers[self.customers.index(current)] = updated
        return updated

    def delete_customer(self, *args):
        raise AssertionError("CRM must archive, never permanently delete")

    def list_customer_activities(self, organization_id, customer_id):
        return []


def make_page(qtbot, client=None, **kwargs):
    client = client or FakeClient()
    page = CustomerPage(client, ORGANIZATION_ID, **kwargs)
    qtbot.addWidget(page)
    return page, client


def test_page_loads_and_searches_formatted_phone_without_hyphens(qtbot):
    page, _ = make_page(qtbot)
    page.search_input.setText("01012345678")
    assert page.customer_table.rowCount() == 1
    page.search_input.setText("없는 고객")
    assert page.customer_table.rowCount() == 0
    assert "고객이 없습니다" in page.empty_label.text()
    assert "0" in page.result_count.text()


def test_full_profile_is_created_atomically_and_stays_selected(qtbot):
    page, client = make_page(qtbot)
    page.name_input.setText("새 고객")
    page.email_input.setText("new@example.com")
    page.tags_input.setText("VIP, VIP, 정기")
    page.concerns_input.setText("건조, 민감")
    page.birth_input.setText("1996-03-14")
    page.skin_input.setText("건성")
    page._save()
    assert len(client.created_values) == 1
    assert client.updated_values == []
    values = client.created_values[0]
    assert values["tags"] == ["VIP", "정기"]
    assert values["concerns"] == ["건조", "민감"]
    assert values["birth_date"] == "1996-03-14"
    assert values["allergies"] == ""
    assert page._selected_id == client.customers[-1].id
    assert page.name_input.text() == "새 고객"
    assert not page.has_unsaved_changes()


def test_save_failure_preserves_all_inputs_without_partial_customer(qtbot):
    page, client = make_page(qtbot)
    client.fail_save = True
    page.name_input.setText("새 고객")
    page.tags_input.setText("VIP")
    page._save()
    assert len(client.customers) == 1
    assert page._selected_id is None
    assert page.tags_input.text() == "VIP"
    assert page.has_unsaved_changes()
    assert page.error_label.text()
    client.fail_save = False
    page._save()
    assert len(client.customers) == 2
    assert not page.error_label.text()


def test_archive_restore_updates_status_without_deleting(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Yes)
    page._archive_customer()
    assert len(client.customers) == 1
    assert client.customers[0].status == "archived"
    assert client.updated_values[-1] == {"status": "archived"}
    assert "복원" in page.delete_button.toolTip()
    page._archive_customer()
    assert client.customers[0].status == "active"


def test_archive_failure_keeps_customer_active(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    client.fail_save = True
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Yes)
    page._archive_customer()
    assert client.customers[0].status == "active"
    assert page._selected_id == client.customers[0].id
    assert page.error_label.text()


def test_dirty_customer_switch_can_cancel_or_discard(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    page.name_input.setText("수정 중")
    other = Customer(uuid4(), "다른 고객")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    page._select_customer(other)
    assert page.name_input.text() == "수정 중"
    assert page._selected_id == client.customers[0].id
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Discard
    )
    page._select_customer(other)
    assert page.name_input.text() == "다른 고객"
    assert not page.has_unsaved_changes()


def test_dirty_navigation_save_failure_does_not_leave(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page.name_input.setText("새 고객")
    client.fail_save = True
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Save)
    assert not page.confirm_leave()
    assert page.name_input.text() == "새 고객"


def test_new_customer_button_protects_unsaved_profile(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    page.notes_input.setPlainText("작성 중 메모")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    page.clear_form_button.click()
    assert page.notes_input.toPlainText() == "작성 중 메모"


def test_readonly_user_cannot_write_even_through_handler(qtbot):
    page, client = make_page(qtbot, can_manage=False)
    page._select_customer(client.customers[0])
    assert not page.save_button.isEnabled()
    assert not page.delete_button.isEnabled()
    assert page.name_input.isReadOnly()
    page.name_input.setText("쓰면 안 됨")
    page._save()
    page._archive_customer()
    assert client.updated_values == []
    assert client.customers[0].name == "김고객"


def test_invalid_email_and_dates_are_not_submitted(qtbot):
    page, client = make_page(qtbot)
    page.name_input.setText("새 고객")
    page.email_input.setText("invalid")
    page._save()
    assert client.created_values == []
    assert "이메일" in page.error_label.text()
    page.email_input.clear()
    page.birth_input.setText("2024-02-31")
    page._save()
    assert client.created_values == []
    assert "날짜" in page.error_label.text()


def test_no_fake_customer_photos_in_live_page(qtbot):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    assert page.large_photo.pixmap.isNull()
    assert page.preview_strip.count() == 0
    assert "없" in page.photo_caption.text()
    assert not page.next_photo.isEnabled()


def test_demo_photo_navigation_is_explicit(qtbot):
    page, _ = make_page(qtbot, demo_photos=True)
    page._step_photo(-1)
    assert page._photo_index == 3
    assert "샘플" in page.photo_caption.text()


def test_customer_photo_loading_runs_off_the_ui_thread(qtbot):
    class SlowPhotoClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.started = Event()
            self.release = Event()

        def list_customer_photos(self, organization_id, customer_id):
            self.started.set()
            self.release.wait(2)
            return []

        def download_customer_photo(self, organization_id, customer_id, photo_id):
            return b""

    client = SlowPhotoClient()
    page = CustomerPage(client, ORGANIZATION_ID)
    qtbot.addWidget(page)
    page._select_customer(client.customers[0])
    assert client.started.wait(1)
    assert page._photo_loading
    client.release.set()
    qtbot.waitUntil(lambda: not page._photo_loading, timeout=3000)


def test_reference_layout_keeps_three_column_cards(qtbot):
    client = FakeClient()
    client.customers = [Customer(uuid4(), f"고객 {i}") for i in range(6)]
    page, _ = make_page(qtbot, client)
    page.resize(1100, 720)
    page.show()
    qtbot.waitExposed(page)
    cards = page.customer_cards
    assert cards[0].y() == cards[2].y()
    assert cards[3].y() > cards[0].y()
    qtbot.mouseClick(cards[2], Qt.MouseButton.LeftButton)
    assert page.profile_name.text() == "고객 2"
    assert page.name_input.text() == "고객 2"


def test_loading_error_has_retry_and_recovers(qtbot):
    class BrokenClient(FakeClient):
        broken = True

        def list_customers(self, organization_id):
            if self.broken:
                raise RuntimeError("offline")
            return super().list_customers(organization_id)

    page, client = make_page(qtbot, BrokenClient())
    assert "불러오지 못했습니다" in page.error_label.text()
    client.broken = False
    page.reload_button.click()
    assert page.customer_table.rowCount() == 1
    assert not page.error_label.text()


def test_window_navigation_and_close_protect_customer_draft(qtbot, monkeypatch):
    from business_assistant_common.entitlements import EntitlementSet
    from business_assistant_desktop.main_window import MainWindow
    from PySide6.QtGui import QCloseEvent

    window = MainWindow(EntitlementSet(frozenset({"crm.basic"})))
    qtbot.addWidget(window)
    page = CustomerPage(FakeClient(), ORGANIZATION_ID)
    old = window.pages.widget(1)
    window.pages.removeWidget(old)
    window.pages.insertWidget(1, page)
    window.navigation_menu.setCurrentRow(1)
    page.name_input.setText("작성 중")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    window.navigation_menu.setCurrentRow(0)
    assert window.pages.currentIndex() == 1
    assert window.navigation_menu.currentRow() == 1
    event = QCloseEvent()
    window.closeEvent(event)
    assert not event.isAccepted()
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Discard
    )
    window.navigation_menu.setCurrentRow(0)
    assert window.pages.currentIndex() == 0
    assert not page.has_unsaved_changes()


def test_customer_switch_protects_activity_draft(qtbot, monkeypatch):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    qtbot.waitUntil(lambda: not page.activity_panel.is_loading)
    page.activity_panel.title_input.setText("작성 중 상담")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **kw: QMessageBox.StandardButton.Cancel)
    page._select_customer(Customer(uuid4(), "다른 고객"))
    assert page._selected_id == client.customers[0].id
    assert page.activity_panel.title_input.text() == "작성 중 상담"


def test_profile_save_does_not_erase_activity_draft(qtbot):
    page, client = make_page(qtbot)
    page._select_customer(client.customers[0])
    qtbot.waitUntil(lambda: not page.activity_panel.is_loading)
    page.activity_panel.title_input.setText("작성 중 상담")
    page.name_input.setText("프로필 수정")
    page._save()
    assert page.activity_panel.title_input.text() == "작성 중 상담"
    assert page.has_unsaved_changes()


def test_bound_customer_adapter_keeps_session_and_organization():
    from types import SimpleNamespace

    from business_assistant_desktop.main_window import _BoundCustomerClient

    calls = []
    session = object()
    customer_id = uuid4()

    def record(*args):
        calls.append(args)
        return []

    api = SimpleNamespace(
        create_customer_record=record,
        list_customer_activities=record,
        create_customer_activity=record,
        update_customer=record,
    )
    bound = _BoundCustomerClient(api, session)
    bound.create_customer_record(ORGANIZATION_ID, {"name": "고객"})
    bound.list_customer_activities(ORGANIZATION_ID, customer_id)
    bound.create_customer_activity(ORGANIZATION_ID, customer_id, {"title": "상담"})
    bound.update_customer(ORGANIZATION_ID, customer_id, {"status": "archived"})
    assert all(call[0] == ORGANIZATION_ID and call[1] is session for call in calls)
    assert calls[1][2] == customer_id
    assert calls[3][3] == {"status": "archived"}
