"""Main application window."""

from business_assistant_common.entitlements import EntitlementSet
from PySide6.QtWidgets import QHBoxLayout, QLabel, QListWidget, QMainWindow, QWidget

from business_assistant_desktop.menu_catalog import visible_menus


class MainWindow(QMainWindow):
    """A minimal shell with entitlement-filtered navigation."""

    def __init__(self, entitlements: EntitlementSet) -> None:
        super().__init__()
        self.setWindowTitle("Business Assistant")
        self.setMinimumSize(1000, 700)

        navigation = QListWidget()
        navigation.addItems([menu.label for menu in visible_menus(entitlements)])

        welcome_panel = QLabel("Welcome to Business Assistant")
        welcome_panel.setObjectName("welcome-panel")

        content = QWidget()
        layout = QHBoxLayout(content)
        layout.addWidget(navigation)
        layout.addWidget(welcome_panel)
        self.setCentralWidget(content)
