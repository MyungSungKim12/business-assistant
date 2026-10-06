"""Shared finish for pages, forms and modal workflows."""

WORKSPACE_STYLE = """
QWidget {
 font-family: "Pretendard", "Segoe UI", "Malgun Gothic";
 font-size: 14px; font-weight: 400; color: #403A35; }
QMainWindow, QDialog, #content-area { background: #F7F3ED; }
QLabel { background: transparent; }
#treatment-form { background: #FFFDF9; }
QScrollArea, QStackedWidget { border: 0; background: transparent; }
#page-title, #workspace-title, #treatment-title { font-size: 26px; font-weight: 700; }
#page-subtitle, #muted, #status, #organization-context { color: #8D8378; font-size: 13px; }
#section-title, #section-heading { font-size: 15px; font-weight: 600; }
#content-card, #surface-panel, #treatment-pane { background: #FFFDF9;
 border: 1px solid #E4D9CD; border-radius: 14px; }
#treatment-lifecycle { background: #F2EAE1; border: 1px solid #E4D9CD;
 border-radius: 10px; padding: 10px 12px; }
#treatment-lifecycle QLabel { color: #75685D; font-weight: 500; }
#treatment-lifecycle #treatment-start, #treatment-lifecycle #treatment-complete {
 background: #B98B68; color: white; border-color: #B98B68; }
#treatment-lifecycle #treatment-start:hover, #treatment-lifecycle #treatment-complete:hover {
 background: #8E684F; border-color: #8E684F; }
#treatment-lifecycle #treatment-start:disabled, #treatment-lifecycle #treatment-complete:disabled {
 background: #F2EAE1; color: #8D8378; border-color: #E4D9CD; }
#treatment-lifecycle #treatment-cancel, #treatment-lifecycle #treatment-correct {
 background: #FFFDF9; color: #75685D; border-color: #D3C5B8; }
#sidebar { background: #E8DED2; }
#sidebar-brand { color: #403A35; font-size: 17px; font-weight: 600; }
#sidebar-caption { color: #8D8378; font-size: 12px; }
#sidebar-footer {
 color: #8D8378; padding: 16px 22px; font-size: 12px;
 font-family: "Pretendard"; font-style: normal; }
#navigation { background: transparent; border: 0; padding: 8px 14px; outline: 0; }
#navigation::item { color: #6F6257; min-height: 24px; padding: 9px 12px;
 border: 0; border-radius: 8px; margin: 2px 0; }
#navigation::item:hover { background: #F2EAE1; color: #403A35; }
#navigation::item:selected, #navigation::item:selected:hover {
 background: #DDCEBA; color: #403A35; }
#navigation::item:disabled { color: #8593A5; }
#all-menu-button { background: transparent; color: #6F6257; border: 0; margin: 0 14px; }
#all-menu-button:hover { background: #F2EAE1; }
#workspace-context { background: white; border-bottom: 1px solid #E4D9CD; }
#context-label { color: #8D8378; font-size: 12px; }
#context-name { font-weight: 600; font-size: 13px; }
QPushButton { min-height: 20px; background: white; color: #403A35;
 border: 1px solid #E4D9CD; border-radius: 8px; padding: 8px 14px; font-weight: 500; }
QPushButton:hover { background: #F2EAE1; border-color: #B98B68; }
QPushButton:pressed { background: #E8DED2; }
QPushButton:focus { border: 1px solid #8E7151; outline: none; }
QPushButton[role="primary"], #save-customer, #treatment-save {
 background: #B98B68; color: white; border: 1px solid #B98B68; font-weight: 600; }
QPushButton[role="primary"]:hover,
#save-customer:hover, #treatment-save:hover { background: #8E684F; border-color: #8E684F; }
QPushButton[role="primary"]:focus, #save-customer:focus, #treatment-save:focus {
 border-color: #C9AE88; }
QPushButton[role="danger"] { color: #B9786D; background: #FFF9F6; }
QPushButton[role="danger"]:hover { background: #F7E8E3; border-color: #D5A79D; }
QPushButton:disabled, QPushButton[role="primary"]:disabled,
#save-customer:disabled, #treatment-save:disabled {
 color: #A89A8B; background: #F2EAE1; border-color: #E4D9CD; }
QLineEdit, QTextEdit, QPlainTextEdit, QAbstractSpinBox { background: white;
 border: 1px solid #E4D9CD; border-radius: 7px; padding: 7px 10px;
 selection-background-color: #EADFD3; selection-color: #403A35; }
QLineEdit:hover, QTextEdit:hover, QPlainTextEdit:hover { border-color: #B98B68; }
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus, QAbstractSpinBox:focus {
 border-color: #9E8262; }
QLineEdit:disabled, QTextEdit:disabled, QPlainTextEdit:disabled {
 background: #F2EAE1; color: #8D8378; }
QLineEdit[readOnly="true"], QTextEdit[readOnly="true"] { background: #FBF7F2; }
QComboBox { background: white; border: 1px solid #E4D9CD; border-radius: 7px;
 min-height: 20px; padding: 7px 32px 7px 10px; }
QComboBox:hover { border-color: #B98B68; }
QComboBox:focus, QComboBox:on { border-color: #9E8262; }
QComboBox:disabled { background: #F2EAE1; color: #8D8378; }
QComboBox QAbstractItemView { background: white; color: #403A35;
 border: 1px solid #E4D9CD; padding: 6px; outline: 0;
 selection-background-color: #F0E9E0; selection-color: #403A35; }
QTableView, QListView { background: white; alternate-background-color: #FFFCF8;
 border: 1px solid #E4D9CD; border-radius: 10px; gridline-color: #F0E7DE;
 selection-background-color: #F2EAE1; selection-color: #403A35; outline: 0; }
QTableView::item { padding: 7px; border: 0; border-bottom: 1px solid #F0E7DE; }
QListView::item { padding: 12px; border-radius: 6px; }
QListView::item:hover { background: #F2F5F8; }
QListView::item:selected { background: #F2EAE1; color: #403A35; }
QHeaderView::section { background: #F2EAE1; color: #75685D; font-size: 12px;
 font-weight: 600; border: 0; border-bottom: 1px solid #E4D9CD; padding: 10px; }
QTableCornerButton::section { background: #F2EAE1; border: 0; }
QTabWidget::pane { background: white; border: 0; border-top: 1px solid #E4D9CD; }
QTabBar::tab { background: transparent; color: #8D8378; padding: 11px 16px;
 border: 0; border-bottom: 2px solid transparent; }
QTabBar::tab:selected { color: #B98B68; border-bottom: 2px solid #A88A68; font-weight: 600; }
QTabBar::tab:hover { background: #F4F6F8; }
QCheckBox, QRadioButton { spacing: 8px; background: transparent; }
QGroupBox { border: 1px solid #E4D9CD; border-radius: 10px; margin-top: 14px; padding: 16px; }
QGroupBox::title { subcontrol-origin: margin; left: 14px; padding: 0 6px; font-weight: 600; }
QScrollBar:vertical { width: 6px; background: transparent; margin: 3px 0; }
QScrollBar:horizontal { height: 6px; background: transparent; margin: 0 3px; }
QScrollBar::handle:vertical { background: #D3C5B8; border-radius: 3px; min-height: 28px; }
QScrollBar::handle:horizontal { background: #D3C5B8; border-radius: 3px; min-width: 28px; }
QScrollBar::handle:hover { background: #B98B68; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background: transparent; }
QToolTip { background: #B98B68; color: white; border: 0; padding: 8px; }
QMenu { background: white; border: 1px solid #E4D9CD; padding: 6px; }
QMenu::item { padding: 8px 24px; border-radius: 5px; }
QMenu::item:selected { background: #F2EAE1; }
#caution-panel { background: #F3E8DA; color: #76563F; padding: 16px; border-radius: 10px; }
#summary-card { background: #FFFDF9; border: 1px solid #E4D9CD; border-radius: 12px;
 padding: 22px; font-size: 20px; font-weight: 600; }
#status-banner, #toast {
 padding: 12px 16px; border-radius: 8px; background: #F2EAE1; color: #75685D; }
#status-banner[state="error"], #toast[level="error"], #error { color: #B9786D; }
#toast[level="success"] { background: #EAF1E8; color: #5F7C5B; }
"""
