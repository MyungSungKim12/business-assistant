from business_assistant_desktop.ui_components import (
    DesignTokens,
    SearchFilterBar,
    StatusBanner,
    Toast,
    confirm_action,
)
from PySide6.QtCore import Qt


def test_status_banner_supports_loading_empty_and_error_states(qtbot) -> None:  # type: ignore[no-untyped-def]
    banner = StatusBanner()
    qtbot.addWidget(banner)

    banner.show_loading("불러오는 중...")
    assert banner.state == "loading"
    assert banner.text() == "불러오는 중..."
    assert banner.isVisible()

    banner.show_empty("표시할 항목이 없습니다.")
    assert banner.state == "empty"
    assert banner.text() == "표시할 항목이 없습니다."

    banner.show_error("불러오지 못했습니다.")
    assert banner.state == "error"
    assert banner.text() == "불러오지 못했습니다."

    banner.clear_state()
    assert banner.state is None
    assert not banner.isVisible()


def test_search_filter_bar_emits_query_and_can_reset(qtbot) -> None:  # type: ignore[no-untyped-def]
    bar = SearchFilterBar([("all", "전체"), ("active", "진행 중")])
    qtbot.addWidget(bar)
    seen: list[tuple[str, str]] = []
    bar.changed.connect(lambda query, filter_key: seen.append((query, filter_key)))

    bar.search_input.setText("고객")
    bar.filter_combo.setCurrentIndex(1)
    assert seen[-1] == ("고객", "active")

    qtbot.mouseClick(bar.clear_button, Qt.MouseButton.LeftButton)
    assert bar.query == ""
    assert bar.filter_key == "all"


def test_toast_displays_success_message(qtbot) -> None:  # type: ignore[no-untyped-def]
    toast = Toast.success("저장되었습니다.")
    qtbot.addWidget(toast)
    assert toast.message == "저장되었습니다."
    assert toast.level == "success"
    assert toast.text() == "저장되었습니다."


def test_confirm_action_returns_message_box_result(qtbot, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(
        QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes
    )
    assert confirm_action(None, "삭제", "정말 삭제할까요?") is True


def test_design_tokens_expose_product_palette() -> None:
    assert DesignTokens.primary == "#2563eb"
    assert DesignTokens.surface == "#ffffff"
