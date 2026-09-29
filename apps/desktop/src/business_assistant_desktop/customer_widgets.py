"""Small, native Qt visual components for the customer workspace."""

from pathlib import Path

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPaintEvent, QPixmap
from PySide6.QtWidgets import QFrame, QLabel, QWidget

ASSETS = Path(__file__).with_name("assets")


def label(text: str, name: str = "", wrap: bool = False) -> QLabel:
    widget = QLabel(text)
    widget.setObjectName(name)
    widget.setWordWrap(wrap)
    widget.setTextFormat(Qt.TextFormat.PlainText)
    return widget


class PhotoTile(QWidget):
    """Aspect-fill photograph with a rounded clip; never stretches the source."""

    def __init__(self, path: str = "", sample_index: int = -1, round_avatar: bool = False):
        super().__init__()
        self.round_avatar = round_avatar
        self.pixmap = QPixmap(path) if path else QPixmap()
        self.is_sample = sample_index >= 0 and not path
        if self.is_sample:
            source = QPixmap(str(ASSETS / "treatment-samples.png"))
            half = source.width() // 2
            self.pixmap = source.copy(
                (sample_index % 2) * half + 8,
                (sample_index // 2) * half + 8,
                half - 16,
                half - 16,
            )
        self.setMinimumSize(24, 24)
        self.setToolTip(
            "샘플 이미지 · 고객의 실제 시술 사진이 아닙니다" if self.is_sample else path
        )

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        bounds = QRectF(self.rect())
        clip = QPainterPath()
        radius = self.width() / 2 if self.round_avatar else 6
        clip.addRoundedRect(bounds, radius, radius)
        painter.setClipPath(clip)
        painter.fillRect(self.rect(), QColor("#ece7e2"))
        if not self.pixmap.isNull():
            scaled = self.pixmap.scaled(
                self.size(),
                Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                Qt.TransformationMode.SmoothTransformation,
            )
            painter.drawPixmap(
                (self.width() - scaled.width()) // 2, (self.height() - scaled.height()) // 2, scaled
            )
        else:
            painter.setPen(QColor("#9b8a79"))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "사진 없음" if not self.round_avatar else "고객",
            )


CUSTOMER_STYLE = """
#customer-workspace { background: #faf9f8; }
#customer-workspace QWidget { font-family: "Pretendard"; font-size: 14px; color: #34343a; }
#customer-workspace QLabel { background: transparent; border: none; padding: 0; }
#customer-workspace #workspace-title { font-size: 25px; font-weight: 700; }
#customer-workspace #muted { color: #70685f; font-size: 13px; }
#customer-workspace #section-title { font-size: 14px; font-weight: 600; }
#customer-workspace #profile-name { font-size: 18px; font-weight: 700; }
#customer-workspace #customer-grid {
 background: #f3f0ec; border: 1px solid #eeecea; border-radius: 12px; }
#customer-workspace #info-panel, #customer-workspace #detail-panel {
 background: #fff; border: 1px solid #e7e2dc; border-radius: 12px; }
#customer-workspace QLineEdit, #customer-workspace QComboBox,
#customer-workspace QTextEdit { background: white; border: 1px solid #e1dedb;
 border-radius: 7px; padding: 5px 9px; min-height: 22px; selection-background-color: #bca48a; }
#customer-workspace #info-panel QLineEdit, #customer-workspace #info-panel QComboBox {
 min-height: 20px; padding: 3px 9px; }
#customer-workspace QLineEdit:focus, #customer-workspace QTextEdit:focus { border-color: #c3a27d; }
#customer-workspace QComboBox { padding-right: 28px; }
#customer-workspace QComboBox::drop-down { border: 0; width: 26px; }
#customer-workspace QPushButton { min-height: 22px; padding: 6px 12px; border-radius: 7px;
 background: #faf8f5; border: 1px solid #e4dbd2; color: #393737; font-weight: 500; }
#customer-workspace QPushButton:hover { background: #e5d8ca; }
#customer-workspace QPushButton#photo-navigation { padding: 0; min-height: 32px; }
#customer-workspace QPushButton#save-customer { background: #222a36; color: white; border: 0; }
#customer-workspace QPushButton#save-customer:hover { background: #394354; }
#customer-workspace QPushButton#treatment-customer-card {
 background: #fff; border: 1px solid #eeecea;
 border-radius: 10px; padding: 0; text-align: left; min-height: 150px; }
#customer-workspace QPushButton#treatment-customer-card:hover { border-color: #c7ae92; }
#customer-workspace QPushButton#treatment-customer-card[selected="true"] {
 border: 1px solid #b59775; background: #fcf8f2; }
#customer-workspace #card-name { font-size: 15px; font-weight: 600; }
#customer-workspace #tag { background: #f0ebe5; border-radius: 8px; padding: 2px 7px;
 color: #665c51; font-size: 12px; }
#customer-workspace #card-visit { color: #70685f; font-size: 12px; }
#customer-workspace #card-contact { color: #505862; font-size: 13px; }
#customer-workspace #history-content { background: #faf8f5; padding: 12px;
 border-radius: 8px; color: #3b414a; }
#customer-workspace QTabWidget QWidget { background: white; }
#customer-workspace QTabWidget::pane { border: 0; background: white; }
#customer-workspace QTabBar::tab { background: #f6f4f2; border: 0;
 border-bottom: 3px solid transparent; padding: 8px 18px; color: #79726c; }
#customer-workspace QTabBar::tab:selected { border-bottom-color: #303641; color: #303641; }
#customer-workspace QScrollArea, #customer-workspace QScrollArea > QWidget > QWidget {
 background: transparent; border: 0; }
#customer-workspace QScrollBar:vertical { background: transparent; width: 5px; }
#customer-workspace QScrollBar::handle:vertical {
 background: #d8cdc2; min-height: 25px; border-radius: 2px; }
#customer-workspace QScrollBar::add-line:vertical,
#customer-workspace QScrollBar::sub-line:vertical {
 height: 0; }
#customer-workspace #timeline { background: white;
 border-left: 1px solid #d9c1a5; padding-left: 12px; }
#customer-workspace #error { color: #a44437; }
"""


class SidebarPanel(QFrame):
    """Fine gold curves echo the reference artwork without a bitmap background."""

    def paintEvent(self, event: QPaintEvent) -> None:
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor("#a38663"))
        for offset in (0, 26):
            path = QPainterPath()
            path.moveTo(-20, self.height() - 220 - offset)
            path.cubicTo(
                16,
                self.height() - 140,
                120,
                self.height() - 160,
                self.width() + 10,
                self.height() - 46 + offset,
            )
            painter.drawPath(path)
