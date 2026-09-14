from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.main_window import MainWindow


def test_main_window_has_product_title(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow(EntitlementSet(frozenset()))
    qtbot.addWidget(window)

    assert window.windowTitle() == "Business Assistant"
