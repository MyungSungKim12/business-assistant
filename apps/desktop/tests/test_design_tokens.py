from business_assistant_desktop.design_tokens import COLORS, application_stylesheet


def test_design_tokens_cover_core_product_states() -> None:
    assert COLORS["canvas"] == "#F7F8FA"
    assert COLORS["primary"] == "#2563EB"
    assert all(name in COLORS for name in ("success", "warning", "danger"))


def test_application_stylesheet_enforces_keyboard_and_click_targets() -> None:
    stylesheet = application_stylesheet()

    assert "min-height: 36px" in stylesheet
    assert "#navigation::item:focus" in stylesheet
    assert "QPushButton:focus" in stylesheet
