"""Finance ledger filters and summary cards for the desktop application."""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True, slots=True)
class Transaction:
    id: UUID
    transaction_type: str
    amount: Decimal
    transaction_date: date
    category: str
    counterparty: str = ""
    memo: str = ""


@dataclass(frozen=True, slots=True)
class FinanceSummary:
    income_total: Decimal
    expense_total: Decimal
    net_total: Decimal
    transaction_count: int


class FinanceClient(Protocol):
    """Operations the finance page needs from its API boundary."""

    def list_transactions(
        self,
        organization_id: UUID,
        transaction_type: str | None,
        from_date: date | None,
        to_date: date | None,
    ) -> list[Transaction]: ...

    def get_finance_summary(
        self, organization_id: UUID, from_date: date | None, to_date: date | None
    ) -> FinanceSummary: ...


_TYPES: list[tuple[str, str | None]] = [("전체", None), ("수입", "income"), ("지출", "expense")]


class FinancePage(QWidget):
    """Display filtered transactions and totals for one organization."""

    def __init__(self, client: FinanceClient, organization_id: UUID) -> None:
        super().__init__()
        self._client = client
        self._organization_id = organization_id

        heading = QLabel("매출·지출")
        heading.setObjectName("page-title")
        self.type_filter = QComboBox()
        self.type_filter.addItems([label for label, _ in _TYPES])
        self.from_date_input = QLineEdit()
        self.from_date_input.setPlaceholderText("YYYY-MM-DD")
        self.to_date_input = QLineEdit()
        self.to_date_input.setPlaceholderText("YYYY-MM-DD")
        refresh_button = QPushButton("조회")
        refresh_button.clicked.connect(self.refresh)
        toolbar = QHBoxLayout()
        toolbar.addWidget(heading)
        toolbar.addStretch()
        toolbar.addWidget(QLabel("유형"))
        toolbar.addWidget(self.type_filter)
        toolbar.addWidget(QLabel("시작일"))
        toolbar.addWidget(self.from_date_input)
        toolbar.addWidget(QLabel("종료일"))
        toolbar.addWidget(self.to_date_input)
        toolbar.addWidget(refresh_button)

        self.income_total_label = QLabel()
        self.expense_total_label = QLabel()
        self.net_total_label = QLabel()
        totals = QHBoxLayout()
        totals.addWidget(self.income_total_label)
        totals.addWidget(self.expense_total_label)
        totals.addWidget(self.net_total_label)
        totals.addStretch()

        self.transaction_table = QTableWidget(0, 5)
        self.transaction_table.setHorizontalHeaderLabels(
            ["거래일", "유형", "금액", "카테고리", "거래처"]
        )
        self.transaction_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addLayout(toolbar)
        layout.addLayout(totals)
        layout.addWidget(self.transaction_table)
        layout.addWidget(self.status_label)
        self.refresh()

    def refresh(self) -> None:
        try:
            from_date = _parse_optional_date(self.from_date_input.text())
            to_date = _parse_optional_date(self.to_date_input.text())
        except ValueError:
            self.status_label.setText("날짜는 YYYY-MM-DD 형식으로 입력하세요.")
            return
        if from_date is not None and to_date is not None and from_date > to_date:
            self.status_label.setText("조회 시작일은 종료일보다 늦을 수 없습니다.")
            return
        transaction_type = _TYPES[self.type_filter.currentIndex()][1]
        self.status_label.setText("재무 내역을 불러오는 중...")
        try:
            transactions = self._client.list_transactions(
                self._organization_id, transaction_type, from_date, to_date
            )
            summary = self._client.get_finance_summary(self._organization_id, from_date, to_date)
        except PermissionError:
            self._clear()
            self.status_label.setText("재무 접근 권한이 없습니다.")
            return
        except Exception:
            self._clear()
            self.status_label.setText("재무 내역을 불러오지 못했습니다.")
            return
        self._render_transactions(transactions)
        self.income_total_label.setText(f"수입 {_money(summary.income_total)}")
        self.expense_total_label.setText(f"지출 {_money(summary.expense_total)}")
        self.net_total_label.setText(f"순액 {_money(summary.net_total)}")
        self.status_label.setText(
            f"거래 {len(transactions)}건을 불러왔습니다."
            if transactions
            else "조회된 거래가 없습니다."
        )

    def _render_transactions(self, transactions: list[Transaction]) -> None:
        self.transaction_table.setRowCount(len(transactions))
        for row, transaction in enumerate(transactions):
            values = (
                transaction.transaction_date.isoformat(),
                "수입" if transaction.transaction_type == "income" else "지출",
                _money(transaction.amount),
                transaction.category,
                transaction.counterparty,
            )
            for column, value in enumerate(values):
                self.transaction_table.setItem(row, column, QTableWidgetItem(value))

    def _clear(self) -> None:
        self.transaction_table.setRowCount(0)
        self.income_total_label.clear()
        self.expense_total_label.clear()
        self.net_total_label.clear()


def _parse_optional_date(value: str) -> date | None:
    value = value.strip()
    return date.fromisoformat(value) if value else None


def _money(value: Decimal) -> str:
    return f"{value:,.0f}원"
