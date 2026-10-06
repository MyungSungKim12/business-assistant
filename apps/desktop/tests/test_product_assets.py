from pathlib import Path

ASSET_ROOT = Path(__file__).parents[1] / "src" / "business_assistant_desktop" / "assets"


def test_product_assets_include_all_fixed_fonts_and_ui_icons():
    expected = {
        "Pretendard-Regular.ttf",
        "Pretendard-Medium.ttf",
        "Pretendard-SemiBold.ttf",
        "Pretendard-Bold.ttf",
        "Pretendard-LICENSE.txt",
        "chevron-down.svg",
        "check.svg",
    }
    assert expected.issubset({path.name for path in ASSET_ROOT.iterdir()})
    assert all((ASSET_ROOT / filename).stat().st_size > 0 for filename in expected)


def test_sample_photo_asset_is_explicitly_separate_from_customer_data():
    sample = ASSET_ROOT / "treatment-samples.png"
    assert sample.exists()
    assert sample.stat().st_size > 0
