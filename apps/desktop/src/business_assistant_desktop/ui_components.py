"""Reusable visual building blocks shared by desktop pages.

The components intentionally keep their data-free API small so pages can use
them without coupling to the API client or a particular feature module.
"""

from dataclasses import dataclass
from typing import Literal

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QWidget,
)

BannerState = Literal["loading", "empty", "error"]


@dataclass(frozen=True, slots=True)
class DesignTokens:
    """Product palette and spacing values used by common components."""

    primary = "#2563eb"
    primary_hover = "#1d4ed8"
    surface = "#ffffff"
    background = "#f7f8fa"
    text = "#111827"
    muted_text = "#6b7280"
    border = "#e5e7eb"
    danger = "#dc2626"
    success = "#16a34a"
    radius = 8
    spacing = 12


class StatusBanner(QLabel):
    """Inline loading, empty and error state message."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.state: BannerState | None = None
        self.setWordWrap(True)
        self.setObjectName("status-banner")
        self.clear_state()

    def _show(self, state: BannerState, message: str) -> None:
        self.state = state
        self.setText(message)
        self.setProperty("state", state)
        self.style().unpolish(self)
        self.style().polish(self)
        self.show()

    def show_loading(self, message: str = "불러오는 중...") -> None:
        self._show("loading", message)

    def show_empty(self, message: str = "표시할 항목이 없습니다.") -> None:
        self._show("empty", message)

    def show_error(self, message: str = "문제가 발생했습니다. 다시 시도해 주세요.") -> None:
        self._show("error", message)

    def clear_state(self) -> None:
        self.state = None
        self.clear()
        self.hide()


class Toast(QLabel):
    """Small non-modal feedback message that can be placed in a page layout."""

    def __init__(self, message: str, level: Literal["success", "error", "info"] = "info") -> None:
        super().__init__(message)
        self.message = message
        self.level = level
        self.setObjectName("toast")
        self.setWordWrap(True)
        self.setProperty("level", level)

    @classmethod
    def success(cls, message: str) -> "Toast":
        return cls(message, "success")

    @classmethod
    def error(cls, message: str) -> "Toast":
        return cls(message, "error")


class SearchFilterBar(QWidget):
    """Consistent search input, filter selector and reset action."""

    changed = Signal(str, str)

    def __init__(
        self, filters: list[tuple[str, str]] | None = None, parent: QWidget | None = None
    ) -> None:
        super().__init__(parent)
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("검색어를 입력하세요")
        self.filter_combo = QComboBox()
        self.clear_button = QPushButton("초기화")
        self.clear_button.setObjectName("secondary-button")
        for key, label in filters or [("all", "전체")]:
            self.filter_combo.addItem(label, key)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(DesignTokens.spacing)
        layout.addWidget(self.search_input, 1)
        layout.addWidget(self.filter_combo)
        layout.addWidget(self.clear_button)
        self.search_input.textChanged.connect(self._emit_changed)
        self.filter_combo.currentIndexChanged.connect(self._emit_changed)
        self.clear_button.clicked.connect(self.reset)

    @property
    def query(self) -> str:
        return self.search_input.text().strip()

    @property
    def filter_key(self) -> str:
        return str(self.filter_combo.currentData() or "all")

    def _emit_changed(self) -> None:
        self.changed.emit(self.query, self.filter_key)

    def reset(self) -> None:
        self.search_input.clear()
        self.filter_combo.setCurrentIndex(0)
        self._emit_changed()


def confirm_action(parent: QWidget | None, title: str, message: str) -> bool:
    """Ask for confirmation and return ``True`` only when the user accepts."""

    result = QMessageBox.question(
        parent,
        title,
        message,
        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        QMessageBox.StandardButton.No,
    )
    return result == QMessageBox.StandardButton.Yes


def install_component_styles(widget: QWidget) -> None:
    """Apply the common visual treatment to a page or application root."""

    widget.setStyleSheet(
        f"""
        #status-banner, #toast {{ padding: 10px 14px; border-radius: {DesignTokens.radius}px; }}
        #status-banner[state='loading'], #status-banner[state='empty'] {{
            background: #eff6ff; color: {DesignTokens.primary};
        }}
        #status-banner[state='error'], #toast[level='error'] {{
            background: #fef2f2; color: {DesignTokens.danger};
        }}
        #toast[level='success'] {{ background: #f0fdf4; color: {DesignTokens.success}; }}
        #secondary-button {{ background: #eef2f7; color: {DesignTokens.text}; }}
        #secondary-button:hover {{ background: #e2e8f0; }}
        """
    )
