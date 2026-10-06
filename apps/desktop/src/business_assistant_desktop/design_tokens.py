"""Shared visual tokens for the desktop application shell."""

from pathlib import Path

COLORS = {
    "canvas": "#F7F3ED",
    "surface": "#FFFDF9",
    "surface_subtle": "#F2EAE1",
    "border": "#E4D9CD",
    "text": "#403A35",
    "muted": "#8D8378",
    "primary": "#B98B68",
    "primary_hover": "#8E684F",
    "success": "#7E9B78",
    "warning": "#C99562",
    "danger": "#B9786D",
    "nav": "#E8DED2",
    "nav_text": "#6F6257",
    "nav_hover": "#F2EAE1",
    "input_border": "#E4D9CD",
    "input_hover": "#B98B68",
}


def application_stylesheet() -> str:
    """Return the shared theme, including the bundled dropdown icon."""
    from business_assistant_desktop.workspace_style import WORKSPACE_STYLE

    arrow = (Path(__file__).parent / "assets" / "chevron-down.svg").as_posix()
    check = (Path(__file__).parent / "assets" / "check.svg").as_posix()
    return (
        WORKSPACE_STYLE
        + f"""
QCheckBox::indicator {{ width: 16px; height: 16px; border: 1px solid #A9B5C3;
 border-radius: 4px; background: white; }}
QCheckBox::indicator:checked {{ image: url("{check}"); background: #B98B68;
 border-color: #B98B68; }}
QCheckBox::indicator:disabled {{ background: #CCD3DC; border-color: #B7C1CD; }}
QCheckBox::indicator:focus {{ border-color: #B98B68; }}
QComboBox::drop-down {{ subcontrol-origin: padding; subcontrol-position: top right;
 width: 28px; border: 0; }}
QComboBox::down-arrow {{ image: url("{arrow}"); width: 12px; height: 12px; }}
QComboBox QAbstractItemView::item {{ min-height: 30px; padding: 5px 10px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
"""
    )
