from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.app import create_main_window
from business_assistant_desktop.main_window import MainWindow
from PySide6.QtCore import Qt


def test_main_window_has_product_title(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow(EntitlementSet(frozenset()))
    qtbot.addWidget(window)

    assert window.windowTitle() == "Business Assistant"


def test_main_window_shows_all_catalog_menus_with_unavailable_features_prepared(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow(EntitlementSet(frozenset()))
    qtbot.addWidget(window)

    assert window.navigation_menu.count() == 15
    items = [window.navigation_menu.item(index) for index in range(15)]
    enabled_labels = [item.text() for item in items if item.flags() & Qt.ItemFlag.ItemIsEnabled]
    prepared_items = [item for item in items if not item.flags() & Qt.ItemFlag.ItemIsEnabled]

    assert enabled_labels == ["홈 대시보드", "계정·구독", "환경설정"]
    assert len(prepared_items) == 12
    assert all(item.text().endswith(" (준비 중)") for item in prepared_items)


def test_main_window_enables_entitled_protected_menu_without_prepared_suffix(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow(EntitlementSet(frozenset({"crm.basic"})))
    qtbot.addWidget(window)

    crm_item = window.navigation_menu.item(1)

    assert crm_item.text() == "고객·거래처"
    assert crm_item.flags() & Qt.ItemFlag.ItemIsEnabled


def test_application_window_factory_accepts_server_entitlements(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = create_main_window(EntitlementSet(frozenset({"crm.basic"})))
    qtbot.addWidget(window)

    crm_item = window.navigation_menu.item(1)

    assert crm_item.flags() & Qt.ItemFlag.ItemIsEnabled
