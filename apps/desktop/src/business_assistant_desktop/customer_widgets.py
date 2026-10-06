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
#customer-workspace { background: #F7F3ED; }
#customer-workspace #profile-name { font-size: 20px; font-weight: 700; }
#customer-grid, #info-panel, #detail-panel {
 background: #FFFDF9; border: 1px solid #E4D9CD; border-radius: 14px; }
#info-panel QLineEdit, #info-panel QComboBox { padding: 4px 8px; }
#photo-navigation { padding: 0; min-height: 28px; }
QPushButton#treatment-customer-card {
 background: #FFFDF9; border: 1px solid #E4D9CD;
 border-radius: 10px; padding: 0; text-align: left; min-height: 146px; }
QPushButton#treatment-customer-card:hover { background: #F2EAE1; border-color: #B98B68; }
QPushButton#treatment-customer-card[selected="true"] {
 border: 2px solid #B98B68; background: #F7EEE5; }
QPushButton#treatment-customer-card:focus { border-color: #8E684F; }
#card-name { font-size: 16px; font-weight: 600; }
#tag { background: #F2EAE1; border-radius: 6px; padding: 3px 7px;
 color: #75685D; font-size: 12px; }
#card-visit { color: #8D8378; font-size: 12px; }
#card-contact { color: #75685D; font-size: 13px; }
#history-content { background: #F2EAE1; padding: 14px; border-radius: 8px; color: #5E5147; }
#customer-workspace QScrollArea, #customer-workspace QScrollArea > QWidget > QWidget {
 background: transparent; border: 0; }
#timeline { background: #FFFDF9; border-left: 2px solid #E4D9CD; padding-left: 12px; }
"""


class SidebarPanel(QFrame):
    """Quiet navigation surface; decoration never competes with menu labels."""
