"""Consistent vector icons for the desktop UI."""

import qtawesome as qta  # type: ignore[import-untyped]
from PySide6.QtCore import QSize
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QAbstractButton


def icon(name: str, color: str = "#18243A") -> QIcon:
    """Return a QtAwesome Material Design icon."""
    return qta.icon(name, color=color)  # type: ignore[no-any-return]


def set_icon(button: QAbstractButton, name: str, color: str = "#18243A") -> None:
    """Apply a shared vector icon and accessible tooltip to a button."""
    button.setIcon(icon(name, color))
    button.setIconSize(QSize(18, 18))
