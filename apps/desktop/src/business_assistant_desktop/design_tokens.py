"""Shared visual tokens for the desktop application shell."""

COLORS = {
    "canvas": "#F7F8FA",
    "surface": "#FFFFFF",
    "surface_subtle": "#F1F5F9",
    "border": "#E2E8F0",
    "text": "#1F2937",
    "muted": "#64748B",
    "primary": "#2563EB",
    "primary_hover": "#1D4ED8",
    "success": "#16A34A",
    "warning": "#D97706",
    "danger": "#DC2626",
    "nav": "#0F172A",
    "nav_text": "#CBD5E1",
}


def application_stylesheet() -> str:
    """Return the single stylesheet used by the application shell."""
    c = COLORS
    return f"""
QMainWindow, QWidget {{ background: {c["canvas"]}; color: {c["text"]}; }}
#top-bar {{ background: {c["surface"]}; border-bottom: 1px solid {c["border"]}; }}
#brand {{ font-size: 18px; font-weight: 700; color: {c["text"]}; }}
#organization-context, #page-subtitle, #status, #sync-status {{ color: {c["muted"]}; }}
#sync-status {{ padding: 6px 10px; background: {c["surface_subtle"]}; border-radius: 6px; }}
#navigation {{ background: {c["nav"]}; border: 0; padding: 12px 8px; }}
#navigation::item {{ color: {c["nav_text"]}; min-height: 36px;
 padding: 8px 12px; border-radius: 7px; }}
#navigation::item:selected, #navigation::item:hover {{
 background: {c["primary"]}; color: #FFFFFF; }}
#navigation::item:focus {{ outline: 2px solid {c["primary"]}; outline-offset: -2px; }}
#navigation::item:disabled {{ color: #64748B; }}
#content-area {{ background: {c["canvas"]}; }}
#content-card {{ background: {c["surface"]}; border: 1px solid {c["border"]};
 border-radius: 10px; }}
#page-title {{ font-size: 24px; font-weight: 700; color: {c["text"]}; }}
QPushButton {{ min-height: 36px; background: {c["primary"]}; color: white;
 border: 0; border-radius: 6px;
 padding: 8px 16px; font-weight: 600; }}
QPushButton:hover {{ background: {c["primary_hover"]}; }}
QPushButton:focus {{ outline: 2px solid {c["primary"]}; outline-offset: 2px; }}
"""
