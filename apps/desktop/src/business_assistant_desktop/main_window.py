"""Main application window."""

from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QLabel, QListWidget, QMainWindow, QWidget

from business_assistant_desktop.menu_catalog import MENU_CATALOG


class MainWindow(QMainWindow):
    """A minimal shell that presents the full product navigation."""

    def __init__(self, entitlements: EntitlementSet) -> None:
        super().__init__()
        self.setWindowTitle("Business Assistant")
        self.setMinimumSize(1000, 700)

        self.navigation_menu = QListWidget()
        for menu in MENU_CATALOG:
            is_available = menu.feature_code is None or entitlements.has(menu.feature_code)
            label = menu.label if is_available else f"{menu.label} (준비 중)"
            self.navigation_menu.addItem(label)
            if not is_available:
                item = self.navigation_menu.item(self.navigation_menu.count() - 1)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEnabled)

        welcome_panel = QLabel("Welcome to Business Assistant")
        welcome_panel.setObjectName("welcome-panel")

        content = QWidget()
        layout = QHBoxLayout(content)
        layout.addWidget(self.navigation_menu)
        layout.addWidget(welcome_panel)
        self.setCentralWidget(content)
