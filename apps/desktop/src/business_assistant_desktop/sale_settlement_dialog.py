"""Daily cash reconciliation and outstanding-balance dialog."""

from datetime import date
from typing import Protocol
from uuid import UUID, uuid4

from PySide6.QtCore import QDate
from PySide6.QtWidgets import (
    QDateEdit,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from business_assistant_desktop.ui_components import polish_table, surface_panel


class SettlementClient(Protocol):
    def get_sale_daily_settlement(
        self, organization_id: UUID, business_date: date
    ) -> dict[str, object]: ...

    def close_sale_day(
        self, organization_id: UUID, business_date: date, payload: dict[str, object]
    ) -> dict[str, object]: ...

    def adjust_sale_day_close(
        self, organization_id: UUID, business_date: date, payload: dict[str, object]
    ) -> dict[str, object]: ...


def _money(value: object) -> str:
    try:
        return f"{int(value):,}원"
    except (TypeError, ValueError):
        return "—"


class SaleSettlementDialog(QDialog):
    def __init__(
        self,
        client: SettlementClient,
        organization_id: UUID,
        *,
        can_manage: bool,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self._client = client
        self._organization_id = organization_id
        self._can_manage = can_manage
        self._settlement: dict[str, object] | None = None
        self.setWindowTitle("미수·일 마감")
        self.resize(820, 660)

        self.date_input = QDateEdit(QDate.currentDate())
        self.date_input.setCalendarPopup(True)
        self.date_input.setDisplayFormat("yyyy-MM-dd")
        self.date_input.dateChanged.connect(lambda _: self.refresh())
        self.cash_label = QLabel("—")
        self.card_label = QLabel("—")
        self.transfer_label = QLabel("—")
        self.expected_label = QLabel("—")
        self.close_status_label = QLabel("마감 전")
        summary = QFormLayout()
        summary.addRow("영업일", self.date_input)
        summary.addRow("현금 수납 / 환불", self.cash_label)
        summary.addRow("카드 수납 / 환불", self.card_label)
        summary.addRow("이체 수납 / 환불", self.transfer_label)
        summary.addRow("예상 시재", self.expected_label)
        summary.addRow("마감 상태", self.close_status_label)
        summary_panel = surface_panel("일 매출 대사", summary)

        self.receivables_table = QTableWidget(0, 4)
        self.receivables_table.setHorizontalHeaderLabels(["고객", "총액", "수납액", "미수금"])
        self.receivables_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.receivables_table)
        receivables_layout = QVBoxLayout()
        receivables_layout.addWidget(self.receivables_table)

        self.counted_cash_input = QLineEdit()
        self.counted_cash_input.setPlaceholderText("실제 현금 시재 (원)")
        self.counted_cash_input.setMaxLength(12)
        self.reason_input = QLineEdit()
        self.reason_input.setPlaceholderText("마감 또는 정정 사유")
        self.counted_cash_input.setEnabled(can_manage)
        self.reason_input.setEnabled(can_manage)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)

        self.refresh_button = QPushButton("새로고침")
        self.refresh_button.clicked.connect(self.refresh)
        self.save_button = QPushButton("마감 저장")
        self.save_button.clicked.connect(self._save_close)
        self.save_button.setEnabled(can_manage)
        self.buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        self.buttons.rejected.connect(self.reject)
        actions = QHBoxLayout()
        actions.addWidget(self.status_label, 1)
        actions.addWidget(self.refresh_button)
        actions.addWidget(self.save_button)
        actions.addWidget(self.buttons)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(14)
        layout.addWidget(summary_panel)
        layout.addWidget(surface_panel("미수 고객", receivables_layout), 1)
        layout.addWidget(
            QLabel("실제 시재와 사유를 입력해 마감하세요. 마감 후 정정은 별도 이력으로 남습니다.")
        )
        form = QFormLayout()
        form.addRow("실제 현금 시재", self.counted_cash_input)
        form.addRow("사유", self.reason_input)
        layout.addWidget(surface_panel("마감 입력", form))
        layout.addLayout(actions)
        self.refresh()

    def _business_date(self) -> date:
        value = self.date_input.date()
        return date(value.year(), value.month(), value.day())

    def refresh(self) -> None:
        self._settlement = None
        self.save_button.setEnabled(False)
        self.status_label.setText("정산 내역을 불러오는 중…")
        try:
            result = self._client.get_sale_daily_settlement(
                self._organization_id, self._business_date()
            )
        except PermissionError:
            self.status_label.setText("정산 조회 권한이 없습니다.")
            return
        except Exception:
            self.status_label.setText("정산 내역을 불러오지 못했습니다. 다시 시도하세요.")
            return
        self._settlement = result
        self.cash_label.setText(
            f"{_money(result.get('cash_received'))} / 환불 {_money(result.get('cash_refunded'))}"
        )
        self.card_label.setText(
            f"{_money(result.get('card_received'))} / 환불 {_money(result.get('card_refunded'))}"
        )
        self.transfer_label.setText(
            f"{_money(result.get('transfer_received'))} / 환불 "
            f"{_money(result.get('transfer_refunded'))}"
        )
        self.expected_label.setText(_money(result.get("expected_cash")))
        rows = result.get("receivables", [])
        if not isinstance(rows, list):
            rows = []
        self.receivables_table.setRowCount(len(rows))
        for row_index, item in enumerate(rows):
            if not isinstance(item, dict):
                continue
            values = [
                str(item.get("customer_name", "")),
                _money(item.get("total_amount")),
                _money(item.get("received_amount")),
                _money(item.get("due_amount")),
            ]
            for column, value in enumerate(values):
                self.receivables_table.setItem(row_index, column, QTableWidgetItem(value))
        close = result.get("close")
        if isinstance(close, dict):
            self.close_status_label.setText(
                f"마감 완료 · 정정 {max(int(close.get('version', 1)) - 1, 0)}회 · "
                f"차이 {_money(close.get('variance'))}"
            )
            self.counted_cash_input.setText(str(close.get("counted_cash", "")))
            self.save_button.setText("마감 정정")
            self.save_button.setEnabled(self._can_manage)
        else:
            self.close_status_label.setText("마감 전")
            self.save_button.setText("마감 저장")
            self.save_button.setEnabled(self._can_manage)
        self.status_label.setText("미수와 결제수단별 합계를 확인하세요.")
        self.save_button.setEnabled(self._can_manage)

    def _save_close(self) -> None:
        if self._settlement is None:
            self.status_label.setText("정산 내역을 먼저 새로고침하세요.")
            return
        counted_cash = self.counted_cash_input.text().strip()
        reason = self.reason_input.text().strip()
        if not counted_cash.isdigit() or len(counted_cash) > 12:
            self.status_label.setText("실제 시재는 0원 이상의 숫자로 입력하세요.")
            return
        if not reason:
            self.status_label.setText("마감 또는 정정 사유를 입력하세요.")
            return
        close = self._settlement.get("close")
        adjusting = isinstance(close, dict)
        action = "마감 정정" if adjusting else "일 마감"
        answer = QMessageBox.question(
            self,
            f"{action} 확인",
            f"{self._business_date()} 정산을 {action}하시겠습니까? "
            "저장 후에는 변경 이력으로 남습니다.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        payload: dict[str, object] = {
            "operation_id": str(uuid4()),
            "counted_cash": counted_cash,
            "reason": reason,
            "confirmed": True,
        }
        try:
            if adjusting:
                payload["expected_version"] = int(close.get("version", 1))
                result = self._client.adjust_sale_day_close(
                    self._organization_id, self._business_date(), payload
                )
            else:
                result = self._client.close_sale_day(
                    self._organization_id, self._business_date(), payload
                )
            self._settlement = result
            self.reason_input.clear()
            self.refresh()
        except PermissionError:
            self.status_label.setText("마감 변경 권한이 없습니다.")
        except Exception:
            self.status_label.setText(
                "저장 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인하세요."
            )
