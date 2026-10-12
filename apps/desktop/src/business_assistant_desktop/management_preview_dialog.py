"""Read-only operating basis with explicit omissions and per-staff sales lines."""

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.ui_components import polish_table


class _Signals(QObject):
    finished = Signal(object)


class _Load(QRunnable):
    def __init__(self, operation: Any) -> None:
        super().__init__()
        self.operation = operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            self.signals.finished.emit((self.operation(), None))
        except Exception as error:
            self.signals.finished.emit((None, error))


class ManagementPreviewDialog(QDialog):
    def __init__(self, client: Any, organization_id: UUID, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.client = client
        self.organization_id = organization_id
        self._worker: _Load | None = None
        self.busy = False
        self.setWindowTitle("운영 수지 · 담당 매출 근거")
        self.resize(800, 560)
        today = date.today()
        self.from_date = QLineEdit(today.replace(day=1).isoformat())
        self.to_date = QLineEdit(today.isoformat())
        self.refresh_button = QPushButton("조회")
        self.refresh_button.clicked.connect(self.refresh)
        filters = QHBoxLayout()
        filters.addWidget(QLabel("시작일"))
        filters.addWidget(self.from_date)
        filters.addWidget(QLabel("종료일"))
        filters.addWidget(self.to_date)
        filters.addWidget(self.refresh_button)
        self.recorded = QLabel("기록된 수지 조회 전")
        self.breakdown = QLabel()
        self.warning = QLabel(
            "관리손익 최종치가 아닙니다. 재고 원가·직원 수당·세금은 계산에 포함되지 않습니다. "
            "담당 매출은 할인·환불 배분 전 판매 항목 총액이며 수당 확정액이 아닙니다."
        )
        self.warning.setWordWrap(True)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["담당자", "항목 수", "판매 항목 총액", "확정 여부"])
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.table)
        self.status = QLabel()
        close_button = QPushButton("닫기")
        close_button.clicked.connect(self.accept)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("운영 수지 · 담당 매출 근거"))
        layout.addLayout(filters)
        layout.addWidget(self.recorded)
        layout.addWidget(self.breakdown)
        layout.addWidget(self.warning)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.status)
        layout.addWidget(close_button)
        self.refresh()

    def refresh(self) -> None:
        if self.busy:
            return
        try:
            start, end = (
                date.fromisoformat(self.from_date.text()),
                date.fromisoformat(self.to_date.text()),
            )
            if end < start or (end - start).days > 366:
                raise ValueError("Invalid period")
        except ValueError:
            self.status.setText("시작일과 종료일을 366일 이내의 YYYY-MM-DD로 입력하세요.")
            return
        self.busy = True
        self.refresh_button.setEnabled(False)
        self.status.setText("기록된 수지를 조회하는 중…")
        self._worker = _Load(
            lambda: self.client.get_management_preview(self.organization_id, start, end)
        )
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        result, error = outcome
        self.busy = False
        self.refresh_button.setEnabled(True)
        if error is not None or not isinstance(result, dict):
            self.status.setText(
                "조회하지 못했습니다. 서버와 036 SQL 적용 상태를 확인하고 다시 시도하세요."
            )
            return
        try:
            if result["is_final_profit"] or result["staff_basis_is_commission"]:
                raise ValueError("Unexpected finalization")
            income = _money(result["recorded_income"])
            expense = _money(result["recorded_expense"])
            net = _money(result["recorded_net"])
            visit_receipts = _money(result["visit_receipts"])
            visit_refunds = _money(result["visit_refunds"])
            rows = result["staff_sales_basis"]
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("Invalid staff rows")
            rendered_rows = [
                [
                    str(row.get("staff_name_snapshot") or "담당 미지정"),
                    str(row["line_count"]),
                    _money(row["gross_line_total"]),
                    "수당 미확정",
                ]
                for row in rows
            ]
        except (InvalidOperation, KeyError, TypeError, ValueError):
            self.status.setText("보고서 형식을 확인할 수 없습니다.")
            return
        self.recorded.setText(f"기록된 수입 {income} · 지출 {expense} · 순액 {net}")
        self.breakdown.setText(
            f"방문 수납 {visit_receipts} · "
            f"방문 환불 {visit_refunds} · "
            f"원장 거래 {result.get('transaction_count', '—')}건"
        )
        self.table.setRowCount(len(rendered_rows))
        for index, values in enumerate(rendered_rows):
            for column, value in enumerate(values):
                self.table.setItem(index, column, QTableWidgetItem(value))
        self.status.setText("조회 완료 · 해당 기간에 기록된 원장 기준")


def _money(raw: object) -> str:
    amount = Decimal(str(raw))
    if not amount.is_finite():
        raise ValueError("Invalid money")
    if amount == amount.to_integral_value():
        return f"{amount:,.0f}원"
    return f"{amount:,.2f}원"
