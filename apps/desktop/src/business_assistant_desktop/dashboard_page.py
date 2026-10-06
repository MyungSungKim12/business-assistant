"""Independent, permission-scoped operational snapshots from existing APIs."""

from collections.abc import Callable
from datetime import datetime

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget


class _Signals(QObject):
    finished = Signal(object)


class _MetricRequest(QRunnable):
    def __init__(self, key: str, read: Callable[[], int]):
        super().__init__()
        self.key, self.read = key, read
        self.signals = _Signals()

    def run(self):
        try:
            outcome = (self, self.read(), None)
        except Exception as exc:
            outcome = (self, None, exc)
        self.signals.finished.emit(outcome)


class DashboardPage(QWidget):
    """Each card owns its freshness and failure state; no fabricated metrics."""

    navigate = Signal(str)

    def __init__(self, readers: dict[str, Callable[[], int]], organization: str):
        super().__init__()
        self._readers = readers
        self._workers: dict[str, _MetricRequest] = {}
        self.values: dict[str, QLabel] = {}
        self.details: dict[str, QLabel] = {}
        self.retry: dict[str, QPushButton] = {}
        self._opened = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 24)
        title = QLabel("매장 운영 현황")
        title.setObjectName("page-title")
        layout.addWidget(title)
        context = QLabel(f"{organization} · 현재 계정의 조회 권한 기준")
        context.setTextFormat(Qt.TextFormat.PlainText)
        context.setObjectName("page-subtitle")
        layout.addWidget(context)
        row = QHBoxLayout()
        row.setSpacing(16)
        for key, name, definition in (
            ("crm", "활성 고객", "조회된 고객 중 보관 고객 제외"),
            ("schedule", "미완료 할 일", "조회된 업무 중 열림·진행 중 상태"),
            ("files", "보관 중인 파일", "조회된 파일 중 보관 처리된 항목 제외"),
        ):
            card = QFrame()
            card.setObjectName("surface-panel")
            box = QVBoxLayout(card)
            box.setContentsMargins(20, 20, 20, 20)
            box.addWidget(QLabel(name))
            value = QLabel("—")
            value.setObjectName("page-title")
            self.values[key] = value
            box.addWidget(value)
            detail = QLabel(
                "아직 조회하지 않았습니다." if key in readers else "조회 권한이 없습니다."
            )
            detail.setWordWrap(True)
            detail.setObjectName("muted")
            self.details[key] = detail
            box.addWidget(detail)
            explanation = QLabel(definition)
            explanation.setWordWrap(True)
            box.addWidget(explanation)
            refresh = QPushButton("새로고침")
            refresh.setEnabled(key in readers)
            refresh.clicked.connect(lambda checked=False, k=key: self.refresh(k))
            self.retry[key] = refresh
            box.addWidget(refresh)
            open_button = QPushButton("목록 보기")
            open_button.setEnabled(key in readers)
            open_button.clicked.connect(lambda checked=False, k=key: self.navigate.emit(k))
            box.addWidget(open_button)
            row.addWidget(card, 1)
        layout.addLayout(row)
        note = QLabel("예약·수납·미수금 지표는 업무 기능 연결 후 제공됩니다.")
        note.setObjectName("page-subtitle")
        note.setWordWrap(True)
        layout.addWidget(note)
        layout.addStretch()

    def open_snapshot(self):
        if not self._opened:
            self._opened = True
            for key in self._readers:
                self.refresh(key)

    def refresh(self, key: str):
        if key not in self._readers or key in self._workers:
            return
        self.values[key].setText("—")
        self.details[key].setText("조회 중…")
        self.retry[key].setEnabled(False)
        worker = _MetricRequest(key, self._readers[key])
        self._workers[key] = worker
        worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(worker)

    @Slot(object)
    def _finished(self, result):
        worker, value, error = result
        key = worker.key
        if self._workers.get(key) is not worker:
            return
        del self._workers[key]
        self.retry[key].setEnabled(True)
        if error:
            self.values[key].setText("—")
            self.details[key].setText("집계 불가 · 새로고침으로 다시 시도하세요.")
        else:
            self.values[key].setText(f"{value:,}")
            self.details[key].setText(datetime.now().strftime("조회 시각 %Y-%m-%d %H:%M:%S"))
