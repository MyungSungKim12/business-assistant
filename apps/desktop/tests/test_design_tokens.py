from business_assistant_desktop.design_tokens import COLORS, application_stylesheet


def test_design_tokens_cover_core_product_states() -> None:
    assert COLORS["canvas"] == "#FAF9F8"
    assert COLORS["primary"] == "#B79C80"
    assert all(name in COLORS for name in ("success", "warning", "danger"))


def test_application_stylesheet_enforces_keyboard_and_click_targets(qtbot) -> None:
    from PySide6.QtWidgets import QPushButton

    stylesheet = application_stylesheet()
    button = QPushButton("조회")
    qtbot.addWidget(button)
    button.setStyleSheet(stylesheet)
    button.ensurePolished()
    assert button.sizeHint().height() >= 36
    assert "QPushButton:focus" in stylesheet


def test_navigation_selection_and_hover_have_distinct_visual_states() -> None:
    stylesheet = application_stylesheet()

    assert "#navigation::item:selected, #navigation::item:hover" not in stylesheet
    assert "#navigation::item:selected" in stylesheet
    assert "#navigation::item:hover" in stylesheet
    assert "#navigation::item:focus" not in stylesheet


def test_global_typography_and_combobox_use_modern_product_style() -> None:
    stylesheet = application_stylesheet()

    assert 'font-family: "Pretendard", "Segoe UI", "Malgun Gothic"' in stylesheet
    assert "QComboBox::drop-down" in stylesheet
    assert "QComboBox QAbstractItemView" in stylesheet
    assert "QComboBox:hover" in stylesheet
    assert "QComboBox:focus" in stylesheet
