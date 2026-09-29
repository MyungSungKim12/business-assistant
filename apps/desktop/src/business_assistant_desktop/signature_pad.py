"""Normalized vector handwriting; resizing never changes stored evidence."""

from copy import deepcopy

from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import QMouseEvent, QPainter, QPaintEvent, QPen
from PySide6.QtWidgets import QWidget


class SignaturePad(QWidget):
    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._strokes: list[list[list[float]]] = []
        self._drawing = False
        self.setMinimumSize(280, 150)
        self.setAccessibleName("고객 손서명 입력")

    def strokes(self) -> list[list[list[float]]]:
        return deepcopy(self._strokes)

    def set_strokes(self, strokes: list[list[list[float]]]) -> None:
        self._drawing = False
        self._strokes = deepcopy(strokes)
        self.update()

    def clear(self) -> None:
        if self.isEnabled():
            self._strokes = []
            self._drawing = False
            self.update()
            self.changed.emit()

    def has_ink(self) -> bool:
        return len({tuple(point) for stroke in self._strokes for point in stroke}) >= 2

    def _point(self, event: QMouseEvent) -> list[float]:
        return [
            round(max(0.0, min(1.0, event.position().x() / max(1, self.width()))), 6),
            round(max(0.0, min(1.0, event.position().y() / max(1, self.height()))), 6),
        ]

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if (
            self.isEnabled()
            and event.button() == Qt.MouseButton.LeftButton
            and len(self._strokes) < 50
            and sum(map(len, self._strokes)) < 5000
        ):
            self._strokes.append([self._point(event)])
            self._drawing = True
            self.update()
            self.changed.emit()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drawing and self.isEnabled() and event.buttons() & Qt.MouseButton.LeftButton:
            self._append(event)

    def _append(self, event: QMouseEvent) -> None:
        point = self._point(event)
        if (
            self._strokes
            and len(self._strokes[-1]) < 500
            and sum(map(len, self._strokes)) < 5000
            and self._strokes[-1][-1] != point
        ):
            self._strokes[-1].append(point)
            self.update()
            self.changed.emit()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if self._drawing and event.button() == Qt.MouseButton.LeftButton:
            self._append(event)
            self._drawing = False

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.white)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QPen(Qt.GlobalColor.darkGray, 1))
        painter.drawRect(self.rect().adjusted(1, 1, -2, -2))
        painter.setPen(
            QPen(
                Qt.GlobalColor.black,
                2.2,
                Qt.PenStyle.SolidLine,
                Qt.PenCapStyle.RoundCap,
                Qt.PenJoinStyle.RoundJoin,
            )
        )
        for stroke in self._strokes:
            if len(stroke) == 1:
                painter.drawPoint(
                    QPointF(stroke[0][0] * self.width(), stroke[0][1] * self.height())
                )
            for first, second in zip(stroke, stroke[1:], strict=False):
                painter.drawLine(
                    QPointF(first[0] * self.width(), first[1] * self.height()),
                    QPointF(second[0] * self.width(), second[1] * self.height()),
                )
        painter.end()
