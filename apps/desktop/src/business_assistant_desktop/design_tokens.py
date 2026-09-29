"""Shared visual tokens for the desktop application shell."""

from pathlib import Path

COLORS = {
    "canvas": "#FAF9F8",
    "surface": "#FFFFFF",
    "surface_subtle": "#F1F5F9",
    "border": "#E2E8F0",
    "text": "#1F2937",
    "muted": "#64748B",
    "primary": "#B79C80",
    "primary_hover": "#A5896C",
    "success": "#16A34A",
    "warning": "#D97706",
    "danger": "#DC2626",
    "nav": "#202833",
    "nav_text": "#CBD5E1",
    "nav_hover": "#2D3947",
    "input_border": "#D8D3CE",
    "input_hover": "#BFA98F",
}


def application_stylesheet() -> str:
    """Return the single stylesheet used by the application shell."""
    c = COLORS
    arrow = (Path(__file__).parent / "assets" / "chevron-down.svg").as_posix()
    return f"""
QMainWindow, QWidget {{
 font-family: "Pretendard", "Segoe UI", "Malgun Gothic";
 font-size: 14px; font-weight: 400;
 background: {c["canvas"]}; color: {c["text"]}; }}
#top-bar {{ background: {c["surface"]}; border-bottom: 1px solid {c["border"]}; }}
#brand {{ font-size: 18px; font-weight: 700; color: {c["text"]}; }}
#organization-context, #page-subtitle, #status, #sync-status {{ color: {c["muted"]}; }}
#sync-status {{ padding: 6px 10px; background: {c["surface_subtle"]}; border-radius: 6px; }}
#navigation {{ background: transparent; border: 0; padding: 12px 12px; outline: 0; }}
#navigation::item {{ color: {c["nav_text"]}; min-height: 28px;
 padding: 8px 12px; border-radius: 9px; margin-bottom: 3px; }}
#navigation::item:hover {{ background: {c["nav_hover"]}; color: #F8FAFC; }}
#navigation::item:selected {{
 background: {c["primary"]}; color: #FFFFFF; }}
#navigation::item:selected:hover {{ background: {c["primary"]}; color: #FFFFFF; }}
#navigation::item:disabled {{ color: #64748B; }}
#content-area {{ background: {c["canvas"]}; }}
#content-card {{ background: {c["surface"]}; border: 1px solid {c["border"]};
 border-radius: 10px; }}
#page-title {{ font-size: 24px; font-weight: 700; color: {c["text"]}; }}
QPushButton {{ min-height: 24px; background: white; color: {c["text"]};
 border: 1px solid {c["input_border"]}; border-radius: 8px;
 padding: 8px 16px; font-weight: 600; }}
QPushButton:hover {{ background: #F4EFE9; border-color: {c["input_hover"]}; }}
QPushButton:pressed {{ background: #E9DFD3; }}
QPushButton:disabled {{ color: #99928A; background: #F2F0ED; border-color: #E8E4DF; }}
QPushButton[role="primary"], QPushButton:default {{ background: #273443; color: white;
 border-color: #273443; }}
QPushButton[role="primary"]:hover, QPushButton:default:hover {{ background: #394B5E; }}
QPushButton:focus {{ outline: 2px solid {c["primary"]}; outline-offset: 2px; }}
#sidebar {{ background: #202833; }}
#brand-mark {{ background: transparent; }}
#sidebar-brand {{ background: transparent; color: #D4C4B2; font-size: 12px; padding: 8px; }}
#sidebar-footer {{ background: transparent; color: #a28e76; font-family: Georgia;
 font-style: italic; padding: 20px; font-size: 12px; }}
#all-menu-button {{ background: transparent; color: #C5B8A9; font-size: 12px; border: 0; }}
QLabel {{ background: transparent; }}
QDialog {{ background: {c["canvas"]}; }}
QLineEdit, QTextEdit {{ background: white; border: 1px solid {c["input_border"]};
 padding: 6px 9px; border-radius: 7px; selection-background-color: {c["primary"]}; }}
QLineEdit:hover, QTextEdit:hover {{ border-color: {c["input_hover"]}; }}
QLineEdit:focus, QTextEdit:focus {{ border: 1px solid {c["primary"]}; }}
QComboBox {{ background: white; border: 1px solid {c["input_border"]};
 border-radius: 8px; min-height: 24px; padding: 6px 38px 6px 12px; }}
QComboBox:hover {{ border: 1px solid {c["input_hover"]}; background: #FFFDFC; }}
QComboBox:focus, QComboBox:on {{ border: 1px solid {c["primary"]}; background: white; }}
QComboBox:disabled {{ background: #F3F1EF; color: #938B84; border-color: #E5E1DD; }}
QComboBox::drop-down {{ subcontrol-origin: padding; subcontrol-position: top right;
 width: 30px; border: 0; }}
QComboBox::down-arrow {{ image: url("{arrow}"); width: 14px; height: 14px; }}
QComboBox QAbstractItemView {{ background: white; color: {c["text"]};
 border: 1px solid {c["input_border"]}; border-radius: 8px; padding: 6px;
 outline: 0; selection-background-color: #EEE5DC; selection-color: {c["text"]}; }}
QComboBox QAbstractItemView::item {{ min-height: 32px; padding: 5px 10px; }}
QTableView, QListView {{ background: white; alternate-background-color: #FAF8F5;
 border: 1px solid #E5E0DA; border-radius: 10px; gridline-color: #F0ECE7;
 selection-background-color: #EEE5DC; selection-color: #273443; outline: 0; }}
QTableView::item {{ padding: 8px; border-bottom: 1px solid #F0ECE7; }}
QHeaderView::section {{ background: #F4F1ED; color: #736B63; font-weight: 600;
 border: 0; border-bottom: 1px solid #E5E0DA; padding: 10px 12px; }}
QTableCornerButton::section {{ background: #F4F1ED; border: 0; }}
QTabWidget::pane {{ background: white; border: 1px solid #E5E0DA; border-radius: 10px; }}
QTabBar::tab {{ background: transparent; color: #827970; padding: 10px 18px;
 border: 0; border-bottom: 2px solid transparent; }}
QTabBar::tab:selected {{ color: #273443; border-bottom: 2px solid #B79C80; font-weight: 600; }}
QTabBar::tab:hover {{ background: #F4EFE9; }}
QScrollBar:vertical {{ width: 7px; background: transparent; margin: 3px 0; }}
QScrollBar::handle:vertical {{ background: #D7CEC3; border-radius: 3px; min-height: 28px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
QToolTip {{ background: #273443; color: white; border: 0; padding: 8px; }}
"""
