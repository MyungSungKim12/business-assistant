import pytest
from business_assistant_desktop.app import create_application
from PySide6.QtGui import QFont, QFontInfo, QRawFont


@pytest.mark.parametrize("weight", [400, 500, 600, 700])
def test_bundled_font_resolves_and_contains_korean_glyphs(qtbot, weight):
    create_application([])
    font = QFont("Pretendard", 10)
    font.setWeight(QFont.Weight(weight))
    assert QFontInfo(font).family() == "Pretendard"
    raw = QRawFont.fromFont(font)
    assert raw.weight() == weight
    assert all(raw.supportsCharacter(ord(ch)) for ch in "고객관리시술예약")


def test_product_font_uses_device_hinting_without_forced_antialiasing(qtbot):
    application = create_application([])
    font = application.font()
    assert font.family() == "Pretendard"
    assert font.hintingPreference() == QFont.HintingPreference.PreferFullHinting
    assert font.styleStrategy() == QFont.StyleStrategy.PreferDefault
