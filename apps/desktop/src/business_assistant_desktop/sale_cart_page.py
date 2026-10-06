"""Three-column visit sale cart workspace."""

from collections.abc import Callable
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.ui_components import polish_table, surface_panel

_VISIT_STATES = {
    "open": "진행 중",
    "checkout_ready": "결제 대기",
    "closed": "수납 완료",
    "canceled": "취소",
}


def _visit_label(visit: dict[str, object]) -> str:
    opened = str(visit.get("opened_at", ""))[:16].replace("T", " ")
    return f"{opened} · {_VISIT_STATES.get(str(visit.get('status')), '상태 확인 필요')}"


class _Signals(QObject):
    finished = Signal(object)


class _Work(QRunnable):
    def __init__(self, kind: str, operation: Callable[[], Any]) -> None:
        super().__init__()
        self.kind, self.operation = kind, operation
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((self.kind, result, error))


class SaleCartWorkspace(QDialog):
    """Review visit charges without creating a payment or finance transaction."""

    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        *,
        can_manage: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id = client, organization_id
        self.can_manage = can_manage
        self.busy = False
        self.customers: list[Any] = []
        self.visits: list[dict[str, object]] = []
        self.drafts: list[dict[str, object]] = []
        self.visible_visits: list[dict[str, object]] = []
        self.visible_drafts: list[dict[str, object]] = []
        self.bundle: dict[str, object] | None = None
        self._line_rows: list[dict[str, object]] = []
        self._worker: _Work | None = None
        self._retry: tuple[str, Callable[[], Any]] | None = None
        self._load_warning = ""
        self._customer_row = -1
        self._visit_row = -1
        self._editor_row = -1
        self._editor_baseline: tuple[object, ...] | None = None
        self._payment_dialog = None
        self.setWindowTitle("방문별 결제 장바구니")
        self.resize(1180, 720)

        root = QVBoxLayout(self)
        root.setContentsMargins(24, 24, 24, 20)
        root.setSpacing(14)
        title = QLabel("결제 장바구니")
        title.setObjectName("page-title")
        root.addWidget(title)
        note = QLabel(
            "시술 청구 초안을 방문별로 검토합니다. "
            "검토 완료 후 실제 받은 금액을 수납 기록에 남기세요."
        )
        note.setWordWrap(True)
        root.addWidget(note)

        columns = QHBoxLayout()
        columns.setSpacing(14)
        self.customer_list = QListWidget()
        self.visit_list = QListWidget()
        self.new_visit_button = QPushButton("새 방문 시작")
        left = QVBoxLayout()
        left.addWidget(QLabel("고객"))
        left.addWidget(self.customer_list, 2)
        left.addWidget(QLabel("방문 내역 · 수납 확인"))
        left.addWidget(self.visit_list, 1)
        left.addWidget(self.new_visit_button)
        columns.addWidget(surface_panel("고객 · 방문", left), 3)

        self.draft_list = QListWidget()
        self.add_draft_button = QPushButton("선택 초안 담기")
        self.add_draft_button.setProperty("role", "primary")
        self.line_table = QTableWidget(0, 5)
        self.line_table.setHorizontalHeaderLabels(["항목", "수량", "단가", "담당자", "상태"])
        self.line_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.line_table)
        center = QVBoxLayout()
        center.addWidget(QLabel("담기 전 시술 초안"))
        center.addWidget(self.draft_list, 1)
        center.addWidget(self.add_draft_button)
        center.addWidget(QLabel("현재 장바구니"))
        center.addWidget(self.line_table, 2)
        editor = QHBoxLayout()
        self.quantity_input = QSpinBox()
        self.quantity_input.setRange(1, 999)
        self.price_input = QLineEdit()
        self.price_input.setPlaceholderText("단가")
        self.staff_input = QLineEdit()
        self.staff_input.setPlaceholderText("담당자")
        editor.addWidget(QLabel("수량"))
        editor.addWidget(self.quantity_input)
        editor.addWidget(self.price_input)
        editor.addWidget(self.staff_input)
        center.addLayout(editor)
        line_actions = QHBoxLayout()
        self.save_line_button = QPushButton("항목 수정")
        self.remove_line_button = QPushButton("항목 제거")
        self.restore_line_button = QPushButton("제거 취소")
        self.removal_reason_input = QLineEdit()
        self.removal_reason_input.setPlaceholderText("제거 사유")
        line_actions.addWidget(self.removal_reason_input, 1)
        line_actions.addWidget(self.save_line_button)
        line_actions.addWidget(self.remove_line_button)
        line_actions.addWidget(self.restore_line_button)
        center.addLayout(line_actions)
        columns.addWidget(surface_panel("청구 항목", center), 5)

        self.subtotal_label = QLabel("소계 0원")
        self.discount_label = QLabel("할인 0원")
        self.total_label = QLabel("청구 예정 0원")
        self.total_label.setObjectName("page-subtitle")
        self.review_button = QPushButton("검토 완료")
        self.review_button.setProperty("role", "primary")
        self.payment_button = QPushButton("수납 기록 · 내역")
        self.payment_button.setProperty("role", "primary")
        self.cancel_visit_button = QPushButton("빈 방문 취소")
        self.cancel_visit_button.setProperty("role", "danger")
        self.retry_button = QPushButton("같은 요청 재시도")
        self.retry_button.hide()
        right = QVBoxLayout()
        right.addWidget(self.subtotal_label)
        right.addWidget(self.discount_label)
        right.addWidget(self.total_label)
        right.addStretch()
        right.addWidget(QLabel("검토 완료는 결제 완료가 아닙니다."))
        right.addWidget(self.review_button)
        right.addWidget(self.payment_button)
        right.addWidget(self.cancel_visit_button)
        right.addWidget(self.retry_button)
        columns.addWidget(surface_panel("금액 검토", right), 3)
        root.addLayout(columns, 1)

        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)
        self.refresh_button = QPushButton("자료 새로고침")
        self.refresh_button.clicked.connect(self.reload)
        root.addWidget(self.refresh_button)
        close_button = QPushButton("닫기")
        close_button.clicked.connect(self.reject)
        root.addWidget(close_button)

        self.customer_list.currentRowChanged.connect(self._select_customer)
        self.visit_list.currentRowChanged.connect(self._select_visit)
        self.draft_list.currentRowChanged.connect(self._controls)
        self.line_table.itemSelectionChanged.connect(self._select_line)
        self.new_visit_button.clicked.connect(self._create_visit)
        self.add_draft_button.clicked.connect(self._add_draft)
        self.review_button.clicked.connect(self._review)
        self.cancel_visit_button.clicked.connect(self._cancel_visit)
        self.save_line_button.clicked.connect(self._save_line)
        self.remove_line_button.clicked.connect(self._remove_line)
        self.restore_line_button.clicked.connect(self._restore_line)
        self.retry_button.clicked.connect(self._retry_pending)
        self.payment_button.clicked.connect(self._open_payments)
        for button in self.findChildren(QPushButton):
            button.setAutoDefault(False)
        self.reload()

    def _run(self, kind: str, operation: Callable[[], Any], *, retryable: bool = False) -> None:
        if self.busy:
            return
        if (
            self._retry is None
            and kind in {"create", "add", "review", "cancel", "restore"}
            and not self._discard_editor()
        ):
            return
        self.busy = True
        if retryable:
            self._retry = (kind, operation)
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def reload(self) -> None:
        if not self._allow_context_change():
            return
        self.status_label.setText("고객과 열린 방문, 시술 초안을 불러오는 중…")
        self._run(
            "load",
            lambda: (
                _attempt(lambda: self.client.list_customers(self.organization_id)),
                _attempt(lambda: self.client.list_customer_visits(self.organization_id)),
                _attempt(lambda: self.client.list_treatment_sale_drafts(self.organization_id)),
            ),
        )

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            status = (
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            )
            if status in {400, 401, 403, 404, 409, 422}:
                self._retry = None
                self.retry_button.hide()
                self.status_label.setText(
                    {
                        409: (
                            "다른 변경과 충돌했습니다. 입력은 유지했습니다. "
                            "자료를 새로고침한 뒤 다시 검토하세요."
                        ),
                        422: "입력값을 확인하세요. 작성 내용은 유지했습니다.",
                        400: "요청 내용을 확인하세요. 작성 내용은 유지했습니다.",
                        401: "로그인이 만료되었습니다. 작성 내용을 확인한 뒤 다시 로그인하세요.",
                        403: "이 작업에 필요한 권한이 없습니다. 작성 내용은 유지했습니다.",
                        404: "대상을 찾을 수 없습니다. 자료를 새로고침해 주세요.",
                    }[status]
                )
                self._controls()
                return
            self.status_label.setText(
                "요청을 완료하지 못했습니다. 화면의 기존 내용은 유지됩니다. "
                "같은 요청을 다시 시도하세요."
            )
            self.retry_button.setVisible(self._retry is not None)
            self._controls()
            return
        if kind == "load":
            outcomes = result
            values = [outcome[0] for outcome in outcomes]
            failures = sum(outcome[1] is not None for outcome in outcomes)
            if values[0] is not None:
                self.customers = values[0]
                self.customer_list.blockSignals(True)
                self.customer_list.clear()
                for customer in self.customers:
                    phone = getattr(customer, "phone", "") or "연락처 없음"
                    self.customer_list.addItem(f"{getattr(customer, 'name', '')}\n{phone}")
                self.customer_list.blockSignals(False)
            if values[1] is not None:
                self.visits = values[1]
            if values[2] is not None:
                self.drafts = values[2]
            self._load_warning = (
                f"일부 자료 {failures}개를 불러오지 못했습니다. 성공한 자료는 유지했습니다."
                if failures
                else ""
            )
            if self.customers:
                self._editor_baseline = None
                self._customer_row = -1
                self.customer_list.blockSignals(True)
                self.customer_list.setCurrentRow(0)
                self.customer_list.blockSignals(False)
                self._select_customer(0)
            else:
                self._clear_cart()
                self.status_label.setText("등록된 고객이 없습니다.")
        elif kind == "cart":
            self._render_bundle(result)
            self.status_label.setText(
                self._load_warning
                or "방문 내역을 불러왔습니다. 실제 수납은 ‘수납 기록 · 내역’에서 확인하세요."
            )
        elif kind in {"create", "add", "update", "remove", "restore", "review", "cancel"}:
            self._retry = None
            self.retry_button.hide()
            if kind == "create":
                self._insert_created_visit(result)
            self._render_bundle(result)
            self.status_label.setText(
                "장바구니를 저장했습니다. 아직 수납이나 매출로 확정되지 않았습니다."
            )
        self._controls()

    def _select_customer(self, row: int) -> None:
        if row != self._customer_row and not self._allow_context_change():
            self.customer_list.blockSignals(True)
            self.customer_list.setCurrentRow(self._customer_row)
            self.customer_list.blockSignals(False)
            return
        self._customer_row = row
        self._visit_row = -1
        self._clear_cart()
        self.visit_list.blockSignals(True)
        self.visit_list.clear()
        self.visit_list.blockSignals(False)
        self.draft_list.clear()
        self.bundle = None
        if not (0 <= row < len(self.customers)):
            self._controls()
            return
        customer_id = str(self.customers[row].id)
        self.visible_visits = [
            visit
            for visit in self.visits
            if str(visit.get("customer_id")) == customer_id
            and visit.get("status") in {"open", "checkout_ready", "closed"}
        ]
        self.visible_drafts = [
            draft for draft in self.drafts if str(draft.get("customer_id")) == customer_id
        ]
        for visit in self.visible_visits:
            self.visit_list.addItem(_visit_label(visit))
        if self.visible_visits:
            self.visit_list.setCurrentRow(0)
        else:
            self._render_drafts()
            self.status_label.setText("열린 방문이 없습니다. 새 방문을 시작하세요.")
        self._controls()

    def _select_visit(self, row: int) -> None:
        if row != self._visit_row and not self._allow_context_change():
            self.visit_list.blockSignals(True)
            self.visit_list.setCurrentRow(self._visit_row)
            self.visit_list.blockSignals(False)
            return
        if not (0 <= row < len(self.visible_visits)):
            return
        self._visit_row = row
        self._clear_cart()
        visit_id = UUID(str(self.visible_visits[row]["id"]))
        self.status_label.setText("선택한 방문의 장바구니를 불러오는 중…")
        self._run("cart", lambda: self.client.get_sale_cart(self.organization_id, visit_id))

    def _render_bundle(self, bundle: dict[str, object]) -> None:
        self._clear_cart()
        self.bundle = bundle
        visit = bundle.get("visit")
        if isinstance(visit, dict):
            for collection in (self.visits, self.visible_visits):
                for row in collection:
                    if row.get("id") == visit.get("id"):
                        row.update(visit)
            for index, row in enumerate(self.visible_visits):
                item = self.visit_list.item(index)
                if item is not None:
                    item.setText(_visit_label(row))
        lines = bundle.get("lines", [])
        rows = [row for row in lines if isinstance(row, dict)] if isinstance(lines, list) else []
        self._line_rows = rows
        self.line_table.setRowCount(len(rows))
        for index, row in enumerate(rows):
            values = (
                str(row.get("description_snapshot", "")),
                str(row.get("quantity", "")),
                _money(row.get("unit_price", 0)),
                str(row.get("staff_name_snapshot", "")),
                "제거됨" if row.get("status") == "removed" else "활성",
            )
            for column, value in enumerate(values):
                self.line_table.setItem(index, column, QTableWidgetItem(value))
        cart = bundle.get("cart", {})
        if isinstance(cart, dict):
            self.subtotal_label.setText(f"소계 {_money(cart.get('subtotal', 0))}")
            self.discount_label.setText(f"할인 {_money(cart.get('discount_total', 0))}")
            self.total_label.setText(f"청구 예정 {_money(cart.get('total_amount', 0))}")
        self._render_drafts()

    def _insert_created_visit(self, bundle: dict[str, object]) -> None:
        visit = bundle.get("visit")
        if not isinstance(visit, dict):
            return
        visit_id = str(visit.get("id", ""))
        if all(str(row.get("id")) != visit_id for row in self.visits):
            self.visits.insert(0, visit)
        self.visible_visits = [
            row
            for row in self.visits
            if str(row.get("customer_id")) == str(visit.get("customer_id"))
        ]
        self.visit_list.blockSignals(True)
        self.visit_list.clear()
        for row in self.visible_visits:
            self.visit_list.addItem(_visit_label(row))
        target = next(
            (
                index
                for index, row in enumerate(self.visible_visits)
                if str(row.get("id")) == visit_id
            ),
            -1,
        )
        if target >= 0:
            self.visit_list.setCurrentRow(target)
        self._visit_row = target
        self.visit_list.blockSignals(False)

    def _select_line(self) -> None:
        row = self.line_table.currentRow()
        if row != self._editor_row and not self._allow_context_change():
            self.line_table.blockSignals(True)
            self.line_table.selectRow(self._editor_row)
            self.line_table.blockSignals(False)
            return
        self._editor_row = row
        if not (0 <= row < len(self._line_rows)):
            self._controls()
            return
        line = self._line_rows[row]
        self.quantity_input.setValue(int(line.get("quantity", 1)))
        self.price_input.setText(str(line.get("unit_price", "")))
        self.staff_input.setText(str(line.get("staff_name_snapshot", "")))
        self.removal_reason_input.setText(str(line.get("removal_reason", "")))
        self._editor_baseline = self._editor_values()
        self._controls()

    def _editor_values(self) -> tuple[object, ...]:
        return (
            self.quantity_input.value(),
            self.price_input.text(),
            self.staff_input.text(),
            self.removal_reason_input.text(),
        )

    def _discard_editor(self) -> bool:
        if self._editor_baseline is None or self._editor_values() == self._editor_baseline:
            return True
        return (
            QMessageBox.question(
                self,
                "저장하지 않은 항목",
                "수정 중인 내용을 버리고 이동할까요?",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def _allow_context_change(self) -> bool:
        if self.busy or self._retry is not None:
            self.status_label.setText("현재 요청의 결과를 확인한 뒤 이동하세요.")
            return False
        return self._discard_editor()

    def _clear_cart(self) -> None:
        self.bundle = None
        self._line_rows = []
        self._editor_row = -1
        self._editor_baseline = None
        self.line_table.blockSignals(True)
        self.line_table.setRowCount(0)
        self.line_table.blockSignals(False)
        self.quantity_input.setValue(1)
        self.price_input.clear()
        self.staff_input.clear()
        self.removal_reason_input.clear()
        self.subtotal_label.setText("소계 0원")
        self.discount_label.setText("할인 0원")
        self.total_label.setText("청구 예정 0원")

    def _render_drafts(self) -> None:
        used: set[str] = set()
        if self.bundle and isinstance(self.bundle.get("lines"), list):
            used = {
                str(line.get("source_id"))
                for line in self.bundle["lines"]
                if isinstance(line, dict) and line.get("status") == "active"
            }
        customer_row = self.customer_list.currentRow()
        customer_id = (
            str(self.customers[customer_row].id) if 0 <= customer_row < len(self.customers) else ""
        )
        customer_drafts = [
            draft for draft in self.drafts if str(draft.get("customer_id")) == customer_id
        ]
        available = [draft for draft in customer_drafts if str(draft.get("id")) not in used]
        self.visible_drafts = available
        self.draft_list.clear()
        for draft in available:
            self.draft_list.addItem(
                f"{draft.get('description', '')}\n{_money(draft.get('amount', 0))}"
            )

    def _create_visit(self) -> None:
        row = self.customer_list.currentRow()
        if not self.can_manage or not (0 <= row < len(self.customers)):
            return
        customer_id = UUID(str(self.customers[row].id))
        operation = uuid4()
        self._run(
            "create",
            lambda: self.client.create_customer_visit(self.organization_id, customer_id, operation),
            retryable=True,
        )

    def _add_draft(self) -> None:
        if not self.can_manage or self.bundle is None:
            return
        row = self.draft_list.currentRow()
        if not (0 <= row < len(self.visible_drafts)):
            return
        visit, cart = self.bundle.get("visit"), self.bundle.get("cart")
        if not isinstance(visit, dict) or not isinstance(cart, dict):
            return
        draft_id = UUID(str(self.visible_drafts[row]["id"]))
        operation = uuid4()
        self._run(
            "add",
            lambda: self.client.add_treatment_draft_to_cart(
                self.organization_id,
                UUID(str(visit["id"])),
                draft_id,
                int(cart["version"]),
                operation,
            ),
            retryable=True,
        )

    def _review(self) -> None:
        if not self.can_manage or self.bundle is None:
            return
        visit, cart = self.bundle.get("visit"), self.bundle.get("cart")
        if not isinstance(visit, dict) or not isinstance(cart, dict):
            return
        operation = uuid4()
        self._run(
            "review",
            lambda: self.client.review_sale_cart(
                self.organization_id,
                UUID(str(visit["id"])),
                int(cart["version"]),
                operation,
                True,
            ),
            retryable=True,
        )

    def _cancel_visit(self) -> None:
        if not self.can_manage or self.bundle is None:
            return
        visit = self.bundle.get("visit")
        if not isinstance(visit, dict):
            return
        operation = uuid4()
        self._run(
            "cancel",
            lambda: self.client.cancel_customer_visit(
                self.organization_id,
                UUID(str(visit["id"])),
                int(visit["version"]),
                operation,
            ),
            retryable=True,
        )

    def _selected_line_context(
        self,
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object]] | None:
        row = self.line_table.currentRow()
        if self.bundle is None or not (0 <= row < len(self._line_rows)):
            return None
        visit, cart = self.bundle.get("visit"), self.bundle.get("cart")
        if not isinstance(visit, dict) or not isinstance(cart, dict):
            return None
        return visit, cart, self._line_rows[row]

    def _save_line(self) -> None:
        context = self._selected_line_context()
        if not self.can_manage or context is None:
            return
        visit, cart, line = context
        operation = uuid4()
        values = {
            "quantity": self.quantity_input.value(),
            "unit_price": self.price_input.text().strip(),
            "staff_id": line.get("staff_id"),
            "staff_name": self.staff_input.text().strip(),
        }
        self._run(
            "update",
            lambda: self.client.update_sale_cart_line(
                self.organization_id,
                UUID(str(visit["id"])),
                UUID(str(line["id"])),
                int(cart["version"]),
                operation,
                values,
            ),
            retryable=True,
        )

    def _remove_line(self) -> None:
        context = self._selected_line_context()
        reason = self.removal_reason_input.text().strip()
        if not self.can_manage or context is None or not reason:
            self.status_label.setText("항목을 제거하려면 사유를 입력하세요.")
            return
        visit, cart, line = context
        operation = uuid4()
        self._run(
            "remove",
            lambda: self.client.remove_sale_cart_line(
                self.organization_id,
                UUID(str(visit["id"])),
                UUID(str(line["id"])),
                int(cart["version"]),
                operation,
                reason,
            ),
            retryable=True,
        )

    def _restore_line(self) -> None:
        context = self._selected_line_context()
        if not self.can_manage or context is None:
            return
        visit, cart, line = context
        operation = uuid4()
        self._run(
            "restore",
            lambda: self.client.restore_sale_cart_line(
                self.organization_id,
                UUID(str(visit["id"])),
                UUID(str(line["id"])),
                int(cart["version"]),
                operation,
            ),
            retryable=True,
        )

    def _retry_pending(self) -> None:
        if self._retry is not None and not self.busy:
            kind, operation = self._retry
            self._run(kind, operation, retryable=True)

    def _open_payments(self) -> None:
        if self.bundle is None or not self._allow_context_change():
            return
        from business_assistant_desktop.visit_payment_dialog import VisitPaymentDialog

        visit = self.bundle.get("visit", {})
        if not isinstance(visit, dict):
            return
        self._editor_baseline = None
        self._payment_dialog = VisitPaymentDialog(
            self.client,
            self.organization_id,
            UUID(str(visit["id"])),
            can_manage=self.can_manage,
            parent=self,
            recovery_identity=self.client.payment_recovery_identity,
        )
        self._payment_dialog.exec()
        self._payment_dialog = None
        self._select_visit(self.visit_list.currentRow())

    def _controls(self, *_args: object) -> None:
        for selector in (self.customer_list, self.visit_list, self.line_table, self.draft_list):
            selector.setEnabled(not self.busy and self._retry is None)
        has_customer = self.customer_list.currentRow() >= 0
        has_cart = self.bundle is not None
        cart_status = self.bundle.get("cart", {}).get("status") if self.bundle else None
        self.payment_button.setEnabled(
            not self.busy and self._retry is None and cart_status in {"ready", "collecting", "paid"}
        )
        lines = self.bundle.get("lines", []) if self.bundle else []
        has_active_line = isinstance(lines, list) and any(
            isinstance(line, dict) and line.get("status") == "active" for line in lines
        )
        editable = self.can_manage and not self.busy and self._retry is None
        self.refresh_button.setEnabled(not self.busy and self._retry is None)
        self.new_visit_button.setEnabled(editable and has_customer)
        cart = self.bundle.get("cart", {}) if self.bundle else {}
        editable = editable and isinstance(cart, dict) and cart.get("status") in {"draft", "ready"}
        row = self.line_table.currentRow()
        selected_line = self._line_rows[row] if 0 <= row < len(self._line_rows) else None
        selected_active = selected_line is not None and selected_line.get("status") == "active"
        selected_removed = selected_line is not None and selected_line.get("status") == "removed"
        self.add_draft_button.setEnabled(
            editable and has_cart and self.draft_list.currentRow() >= 0
        )
        self.review_button.setEnabled(editable and has_cart and has_active_line)
        self.cancel_visit_button.setEnabled(editable and has_cart and not has_active_line)
        self.save_line_button.setEnabled(editable and selected_active)
        self.remove_line_button.setEnabled(editable and selected_active)
        self.restore_line_button.setEnabled(editable and selected_removed)
        for widget in (
            self.quantity_input,
            self.price_input,
            self.staff_input,
            self.removal_reason_input,
        ):
            widget.setEnabled(editable and selected_line is not None)
        self.retry_button.setEnabled(not self.busy)

    def confirm_leave(self) -> bool:
        if self._payment_dialog is not None and not self._payment_dialog.confirm_leave():
            return False
        if self.busy:
            self.status_label.setText("현재 요청이 끝난 뒤 닫아주세요.")
            return False
        if self._retry is None:
            return self._discard_editor()
        return (
            QMessageBox.question(
                self,
                "결과 확인이 필요한 요청",
                "저장 결과가 불명확합니다. 재시도를 포기하고 닫을까요?",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def accept(self) -> None:
        if self.confirm_leave():
            super().accept()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            event.accept()
        else:
            event.ignore()


def _money(value: object) -> str:
    try:
        amount = Decimal(str(value))
        if not amount.is_finite():
            raise ValueError("Invalid amount")
        return f"{amount:,.0f}원" if amount == amount.to_integral_value() else f"{amount:,.2f}원"
    except Exception:
        return "금액 확인 필요"


def _attempt(operation: Callable[[], Any]) -> tuple[Any, Exception | None]:
    try:
        return operation(), None
    except Exception as error:
        return None, error
