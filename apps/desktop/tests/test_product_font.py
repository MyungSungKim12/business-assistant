from business_assistant_desktop.app import create_application
from PySide6.QtGui import QFont


def test_product_font_uses_platform_ui_families_and_native_rendering(qtbot):
    application = create_application([])
    font = application.font()
    assert font.families() == ["SUIT", "Segoe UI", "Malgun Gothic"]
    assert font.hintingPreference() == QFont.HintingPreference.PreferDefaultHinting
    assert font.styleStrategy() == QFont.StyleStrategy.PreferDefault


def test_suit_font_resolves_korean_and_real_weights(qtbot):
    from PySide6.QtGui import QFontInfo, QRawFont

    create_application([])
    for weight in (400, 500, 600, 700):
        font = QFont("SUIT", 10)
        font.setWeight(QFont.Weight(weight))
        assert QFontInfo(font).family() == "SUIT"
        raw = QRawFont.fromFont(font)
        assert raw.weight() == weight
        assert all(raw.supportsCharacter(ord(ch)) for ch in "고객관리시술예약012345")
