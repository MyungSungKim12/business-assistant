"""Catalog management and customer membership balance dialogs."""

import json
import re
from collections.abc import Callable
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, QSettings, QThreadPool, Signal, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.ui_components import polish_table, surface_panel


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


class CatalogManagerDialog(QDialog):
    """Manage sale terms and record immutable inventory movements."""

    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        *,
        can_manage: bool,
        parent: QWidget | None = None,
        recovery_store: Any = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id, self.can_manage = client, organization_id, can_manage
        self.busy = False
        self.rows: list[dict[str, object]] = []
        self.selected_row = -1
        self._baseline: tuple[object, ...] | None = None
        self._worker: _Work | None = None
        self._pending: tuple[str, Callable[[], Any]] | None = None
        self._store = recovery_store or QSettings("BusinessAssistant", "catalog-recovery")
        identity = str(getattr(client, "payment_recovery_identity", "local-user"))
        self._key = f"{sha256(identity.encode('utf-8')).hexdigest()}/{organization_id}"
        self._recovery: dict[str, object] | None = None
        self._uncertain = False
        self._recovery_invalid = False
        self.history_dialog: QDialog | None = None
        self.history_table: QTableWidget | None = None
        stored = self._store.value(self._key, "")
        if stored:
            try:
                candidate = json.loads(str(stored))
                if (
                    not isinstance(candidate, dict)
                    or candidate.get("kind") not in {"save", "stock", "stock_change"}
                    or not isinstance(candidate.get("payload"), dict)
                    or not isinstance(candidate.get("product_id"), (str, type(None)))
                ):
                    raise ValueError("Invalid catalog recovery")
                UUID(str(candidate["payload"]["operation_id"]))
                if candidate.get("product_id") is not None:
                    UUID(str(candidate["product_id"]))
                self._recovery = candidate
                self._uncertain = True
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self._recovery_invalid = True
        self.setWindowTitle("상품 · 회원권 관리")
        self.resize(960, 650)

        root = QVBoxLayout(self)
        title = QLabel("상품 · 회원권 관리")
        title.setObjectName("page-title")
        root.addWidget(title)
        guide = QLabel(
            "판매 조건은 장바구니에 담는 순간 고정됩니다. "
            "실물 상품은 입고 수량 안에서만 결제할 수 있습니다."
        )
        guide.setWordWrap(True)
        root.addWidget(guide)

        body = QHBoxLayout()
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["구분", "이름", "SKU", "판매가", "재고", "상태"])
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.table)
        body.addWidget(self.table, 5)

        form = QFormLayout()
        self.kind_input = QComboBox()
        self.kind_input.addItem("실물 상품", "product")
        self.kind_input.addItem("회원권 · 패키지", "membership")
        self.sku_input = QLineEdit()
        self.name_input = QLineEdit()
        self.unit_input = QLineEdit("개")
        self.price_input = QLineEdit()
        self.price_input.setPlaceholderText("원 단위 정수")
        self.benefit_money_input = QLineEdit("0")
        self.benefit_count_input = QSpinBox()
        self.benefit_count_input.setRange(0, 999999)
        self.valid_days_input = QSpinBox()
        self.valid_days_input.setRange(0, 3650)
        self.valid_days_input.setSpecialValueText("기간 제한 없음")
        self.active_input = QCheckBox("판매 중")
        self.active_input.setChecked(True)
        for label, widget in (
            ("종류", self.kind_input),
            ("SKU", self.sku_input),
            ("이름", self.name_input),
            ("판매 단위", self.unit_input),
            ("판매가", self.price_input),
            ("제공 금액", self.benefit_money_input),
            ("제공 횟수", self.benefit_count_input),
            ("유효 일수", self.valid_days_input),
        ):
            form.addRow(label, widget)
        form.addRow("판매 상태", self.active_input)

        actions = QHBoxLayout()
        self.new_button = QPushButton("새 상품")
        self.save_button = QPushButton("저장")
        self.save_button.setProperty("role", "primary")
        actions.addWidget(self.new_button)
        actions.addWidget(self.save_button)
        form.addRow(actions)

        self.stock_quantity_input = QSpinBox()
        self.stock_quantity_input.setRange(0, 1_000_000_000)
        self.stock_quantity_input.setValue(1)
        self.stock_reason_input = QLineEdit()
        self.stock_reason_input.setPlaceholderText("수량 변경 사유")
        self.stock_change_kind = QComboBox()
        self.stock_change_kind.addItem("거래처 반품", "supplier_return")
        self.stock_change_kind.addItem("폐기", "disposal")
        self.stock_change_kind.addItem("실사 수량으로 조정", "stocktake")
        self.stock_button = QPushButton("선택 상품 입고")
        self.stock_change_button = QPushButton("재고 변동 기록")
        self.stock_history_button = QPushButton("재고 변동 이력")
        form.addRow("변동 종류", self.stock_change_kind)
        form.addRow("입고 수량", self.stock_quantity_input)
        form.addRow("수량 변경 사유", self.stock_reason_input)
        form.addRow(self.stock_button)
        form.addRow(self.stock_change_button)
        form.addRow(self.stock_history_button)
        body.addWidget(surface_panel("판매 조건", form), 4)
        root.addLayout(body, 1)

        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)
        footer = QHBoxLayout()
        self.retry_button = QPushButton("같은 요청 재시도")
        self.retry_button.hide()
        close_button = QPushButton("닫기")
        close_button.clicked.connect(self.accept)
        footer.addWidget(self.retry_button)
        footer.addStretch()
        footer.addWidget(close_button)
        root.addLayout(footer)

        self.table.itemSelectionChanged.connect(self._select)
        self.kind_input.currentIndexChanged.connect(self._controls)
        self.stock_change_kind.currentIndexChanged.connect(self._stock_mode_changed)
        self._stock_mode_changed()
        self.new_button.clicked.connect(self._new)
        self.save_button.clicked.connect(self._save)
        self.stock_button.clicked.connect(self._receive_stock)
        self.stock_change_button.clicked.connect(self._change_stock)
        self.stock_history_button.clicked.connect(self._stock_history)
        self.retry_button.clicked.connect(self._retry)
        self._load()

    def _stock_mode_changed(self, *_args: object) -> None:
        if self.stock_change_kind.currentData() == "stocktake":
            self.stock_quantity_input.setRange(0, 1_000_000_000)
        else:
            self.stock_quantity_input.setRange(1, 999999)

    def _run(self, kind: str, operation: Callable[[], Any], *, retryable: bool = False) -> None:
        if self.busy:
            return
        self.busy = True
        if retryable:
            self._pending = (kind, operation)
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def _load(self) -> None:
        self.status_label.setText("상품과 회원권을 불러오는 중…")
        self._run("load", lambda: self.client.list_catalog_products(self.organization_id))

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            status = (
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            )
            if kind in {"save", "stock", "stock_change"}:
                if status in {400, 401, 403, 404, 409, 422} and not self._uncertain:
                    self._pending = None
                    self._clear_recovery()
                else:
                    self._uncertain = True
            self.retry_button.setVisible(self._recovery is not None)
            self.status_label.setText(
                "결과를 확인하지 못했습니다. 로그인 후 같은 요청으로 다시 확인하세요."
                if kind in {"save", "stock", "stock_change"} and self._uncertain
                else "다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요."
                if status == 409
                else "저장하지 못했습니다. 입력 내용은 유지됩니다."
            )
            self._controls()
            return
        if kind == "load":
            self.rows = result
        elif kind in {"save", "stock", "stock_change"}:
            self._clear_recovery()
            row_id = str(result.get("id"))
            match = next((i for i, row in enumerate(self.rows) if str(row.get("id")) == row_id), -1)
            if match < 0:
                self.rows.append(result)
                match = len(self.rows) - 1
            else:
                self.rows[match] = result
            self.selected_row = match
        self._render()
        if kind == "history":
            self.status_label.setText(f"최근 재고 변동 {len(result)}건을 표시했습니다.")
            self._show_stock_history(result)
        else:
            self.status_label.setText(
                "판매 조건을 저장했습니다."
                if kind == "save"
                else "입고를 기록했습니다."
                if kind == "stock"
                else "재고 변동을 기록했습니다."
                if kind == "stock_change"
                else "복구 정보가 손상되어 새 요청을 중지했습니다. 관리자에게 확인을 요청하세요."
                if self._recovery_invalid
                else "결과가 불명확한 요청이 있습니다. 같은 요청을 다시 확인하세요."
                if self._recovery
                else "등록된 상품과 회원권입니다."
            )
        self.retry_button.setVisible(self._recovery is not None)
        self._controls()

    def _render(self) -> None:
        self.table.blockSignals(True)
        self.table.setRowCount(len(self.rows))
        for index, row in enumerate(self.rows):
            values = (
                "상품" if row.get("kind") == "product" else "회원권",
                str(row.get("name", "")),
                str(row.get("sku", "")),
                _money(row.get("sale_price", 0)),
                str(row.get("stock_quantity", "-")) if row.get("kind") == "product" else "-",
                "판매 중" if row.get("is_active") else "판매 중지",
            )
            for column, value in enumerate(values):
                self.table.setItem(index, column, QTableWidgetItem(value))
        if 0 <= self.selected_row < len(self.rows):
            self.table.selectRow(self.selected_row)
        self.table.blockSignals(False)
        if 0 <= self.selected_row < len(self.rows):
            self._fill(self.rows[self.selected_row])

    def _select(self) -> None:
        row = self.table.currentRow()
        if row != self.selected_row and self._dirty() and not self._confirm_discard():
            self.table.blockSignals(True)
            if self.selected_row >= 0:
                self.table.selectRow(self.selected_row)
            else:
                self.table.clearSelection()
            self.table.blockSignals(False)
            return
        if 0 <= row < len(self.rows):
            self.selected_row = row
            self._fill(self.rows[row])
        self._controls()

    def _fill(self, row: dict[str, object]) -> None:
        self.kind_input.setCurrentIndex(0 if row.get("kind") == "product" else 1)
        self.sku_input.setText(str(row.get("sku", "")))
        self.name_input.setText(str(row.get("name", "")))
        self.unit_input.setText(str(row.get("unit_name", "개")))
        self.price_input.setText(str(row.get("sale_price", "")))
        self.benefit_money_input.setText(str(row.get("benefit_money", "0")))
        self.benefit_count_input.setValue(int(str(row.get("benefit_count", 0))))
        self.valid_days_input.setValue(int(str(row.get("valid_days") or 0)))
        self.active_input.setChecked(bool(row.get("is_active", True)))
        self.stock_quantity_input.setValue(1)
        self.stock_reason_input.clear()
        self._baseline = self._form_values()

    def _new(self) -> None:
        if self._dirty() and not self._confirm_discard():
            return
        self.selected_row = -1
        self.table.blockSignals(True)
        self.table.clearSelection()
        self.table.setCurrentCell(-1, -1)
        self.table.blockSignals(False)
        self.kind_input.setCurrentIndex(0)
        for field in (self.sku_input, self.name_input, self.price_input, self.stock_reason_input):
            field.clear()
        self.unit_input.setText("개")
        self.benefit_money_input.setText("0")
        self.benefit_count_input.setValue(0)
        self.valid_days_input.setValue(0)
        self.active_input.setChecked(True)
        self._baseline = self._form_values()
        self._controls()

    def _form_values(self) -> tuple[object, ...]:
        return (
            self.kind_input.currentData(),
            self.sku_input.text(),
            self.name_input.text(),
            self.unit_input.text(),
            self.price_input.text(),
            self.benefit_money_input.text(),
            self.benefit_count_input.value(),
            self.valid_days_input.value(),
            self.active_input.isChecked(),
            self.stock_quantity_input.value(),
            self.stock_change_kind.currentData(),
            self.stock_reason_input.text(),
        )

    def _dirty(self) -> bool:
        return self._baseline is not None and self._form_values() != self._baseline

    def _confirm_discard(self) -> bool:
        return (
            QMessageBox.question(
                self,
                "작성 중인 상품·재고 변경",
                "저장하지 않은 내용을 버릴까요?",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def _values(self) -> dict[str, object] | None:
        kind = str(self.kind_input.currentData())
        price, benefit = self.price_input.text().strip(), self.benefit_money_input.text().strip()
        if (
            not self.sku_input.text().strip()
            or not self.name_input.text().strip()
            or not self.unit_input.text().strip()
            or re.fullmatch(r"[1-9][0-9]{0,11}", price) is None
        ):
            self.status_label.setText("SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.")
            return None
        if kind == "membership" and (
            re.fullmatch(r"(0|[1-9][0-9]{0,11})", benefit) is None
            or (int(benefit) == 0 and self.benefit_count_input.value() == 0)
        ):
            self.status_label.setText("회원권은 제공 금액이나 제공 횟수가 필요합니다.")
            return None
        return {
            "sku": self.sku_input.text().strip(),
            "name": self.name_input.text().strip(),
            "kind": kind,
            "unit_name": self.unit_input.text().strip(),
            "sale_price": price,
            "benefit_money": benefit if kind == "membership" else "0",
            "benefit_count": self.benefit_count_input.value() if kind == "membership" else 0,
            "valid_days": (self.valid_days_input.value() or None) if kind == "membership" else None,
            "is_active": self.active_input.isChecked(),
        }

    def _save(self) -> None:
        if not self.can_manage or (values := self._values()) is None:
            return
        selected = self.rows[self.selected_row] if 0 <= self.selected_row < len(self.rows) else None
        product_id = UUID(str(selected["id"])) if selected else None
        payload = {**values, "operation_id": str(uuid4())}
        if selected:
            payload["expected_version"] = int(str(selected["version"]))
        recovery: dict[str, object] = {
            "kind": "save",
            "product_id": str(product_id) if product_id else None,
            "payload": payload,
        }
        if not self._persist_recovery(recovery):
            return
        self._run(
            "save",
            lambda: self.client.save_catalog_product(self.organization_id, product_id, payload),
            retryable=True,
        )

    def _receive_stock(self) -> None:
        if not self.can_manage or not (0 <= self.selected_row < len(self.rows)):
            return
        row = self.rows[self.selected_row]
        reason = self.stock_reason_input.text().strip()
        if row.get("kind") != "product" or not reason or self.stock_quantity_input.value() < 1:
            self.status_label.setText("실물 상품을 선택하고 입고 사유를 입력하세요.")
            return
        product_id = UUID(str(row["id"]))
        payload = {
            "quantity": self.stock_quantity_input.value(),
            "reason": reason,
            "operation_id": str(uuid4()),
        }
        recovery: dict[str, object] = {
            "kind": "stock",
            "product_id": str(product_id),
            "payload": payload,
        }
        if not self._persist_recovery(recovery):
            return
        self._run(
            "stock",
            lambda: self.client.receive_catalog_stock(self.organization_id, product_id, payload),
            retryable=True,
        )

    def _change_stock(self) -> None:
        if not self.can_manage or not (0 <= self.selected_row < len(self.rows)):
            return
        row = self.rows[self.selected_row]
        kind = str(self.stock_change_kind.currentData())
        quantity = self.stock_quantity_input.value()
        reason = self.stock_reason_input.text().strip()
        if row.get("kind") != "product" or not reason or (kind != "stocktake" and quantity == 0):
            self.status_label.setText(
                "실물 상품과 사유를 확인하세요. 반품·폐기 수량은 1개 이상이어야 합니다."
            )
            return
        product_id = UUID(str(row["id"]))
        payload = {
            "kind": kind,
            "quantity": quantity,
            "reason": reason,
            "expected_version": int(str(row["version"])),
            "operation_id": str(uuid4()),
        }
        recovery: dict[str, object] = {
            "kind": "stock_change",
            "product_id": str(product_id),
            "payload": payload,
        }
        if not self._persist_recovery(recovery):
            return
        self._run(
            "stock_change",
            lambda: self.client.change_catalog_stock(self.organization_id, product_id, payload),
            retryable=True,
        )

    def _stock_history(self) -> None:
        if not (0 <= self.selected_row < len(self.rows)):
            return
        row = self.rows[self.selected_row]
        if row.get("kind") != "product":
            return
        product_id = UUID(str(row["id"]))
        self._run(
            "history",
            lambda: self.client.list_catalog_stock_ledger(self.organization_id, product_id),
        )

    def _show_stock_history(self, movements: list[dict[str, object]]) -> None:
        row = self.rows[self.selected_row] if 0 <= self.selected_row < len(self.rows) else {}
        dialog = QDialog(self)
        dialog.setWindowTitle(f"{row.get('name', '상품')} · 재고 변동 이력")
        dialog.resize(700, 420)
        layout = QVBoxLayout(dialog)
        table = QTableWidget(0, 4)
        table.setHorizontalHeaderLabels(["일시", "변동 종류", "수량", "사유"])
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(table)
        labels = {
            "receipt": "입고",
            "sale": "판매 출고",
            "refund": "환불 복원",
            "customer_return": "고객 상품 반품",
            "supplier_return": "거래처 반품",
            "disposal": "폐기",
            "stocktake": "실사 조정",
        }
        table.setRowCount(len(movements))
        for index, movement in enumerate(movements):
            quantity = int(str(movement.get("quantity", 0)))
            values = (
                str(movement.get("created_at", ""))[:16].replace("T", " "),
                labels.get(str(movement.get("movement_kind", "")), "기타"),
                f"{quantity:+,} {row.get('unit_name', '')}",
                str(movement.get("reason", "")),
            )
            for column, value in enumerate(values):
                table.setItem(index, column, QTableWidgetItem(value))
        table.resizeColumnsToContents()
        layout.addWidget(table)
        self.history_table = table
        close_button = QPushButton("닫기")
        close_button.clicked.connect(dialog.accept)
        layout.addWidget(close_button)
        self.history_dialog = dialog
        dialog.open()

    def _retry(self) -> None:
        if self._pending and not self.busy:
            kind, operation = self._pending
            self._run(kind, operation, retryable=True)
        elif self._recovery and not self.busy:
            kind = str(self._recovery["kind"])
            stored_payload = self._recovery.get("payload")
            if not isinstance(stored_payload, dict):
                self.status_label.setText("복구할 요청이 올바르지 않습니다.")
                return
            payload: dict[str, object] = stored_payload
            product_text = self._recovery.get("product_id")
            product_id = UUID(str(product_text)) if product_text else None
            if kind == "save":

                def operation() -> Any:
                    return self.client.save_catalog_product(
                        self.organization_id, product_id, payload
                    )
            else:
                if product_id is None:
                    self.status_label.setText("복구할 입고 요청이 올바르지 않습니다.")
                    return

                if kind == "stock_change":

                    def operation() -> Any:
                        return self.client.change_catalog_stock(
                            self.organization_id, product_id, payload
                        )
                else:

                    def operation() -> Any:
                        return self.client.receive_catalog_stock(
                            self.organization_id, product_id, payload
                        )

            self._run(kind, operation, retryable=True)

    def _persist_recovery(self, recovery: dict[str, object]) -> bool:
        if self._recovery_invalid:
            self.status_label.setText(
                "복구 정보가 손상되어 새 요청을 중지했습니다. 관리자에게 확인을 요청하세요."
            )
            return False
        self._store.setValue(self._key, json.dumps(recovery, ensure_ascii=False))
        self._store.sync()
        if self._store.status() != QSettings.Status.NoError:
            self.status_label.setText("복구 정보를 저장하지 못해 요청을 보내지 않았습니다.")
            return False
        self._recovery = recovery
        self._uncertain = False
        return True

    def _clear_recovery(self) -> None:
        self._store.remove(self._key)
        self._store.sync()
        if self._store.status() == QSettings.Status.NoError:
            self._recovery = None
            self._pending = None
            self._uncertain = False
            self._recovery_invalid = False
            self.retry_button.hide()

    def _controls(self, *_args: object) -> None:
        membership = self.kind_input.currentData() == "membership"
        selected = self.rows[self.selected_row] if 0 <= self.selected_row < len(self.rows) else None
        editable = (
            self.can_manage
            and not self.busy
            and self._pending is None
            and self._recovery is None
            and not self._recovery_invalid
        )
        self.table.setEnabled(
            not self.busy
            and self._pending is None
            and self._recovery is None
            and not self._recovery_invalid
        )
        self.new_button.setEnabled(editable)
        self.save_button.setEnabled(editable)
        self.kind_input.setEnabled(editable and selected is None)
        for widget in (
            self.sku_input,
            self.name_input,
            self.unit_input,
            self.price_input,
            self.active_input,
            self.benefit_money_input,
            self.benefit_count_input,
            self.valid_days_input,
        ):
            widget.setEnabled(editable)
        for widget in (self.benefit_money_input, self.benefit_count_input, self.valid_days_input):
            widget.setEnabled(editable and membership)
        stock = editable and selected is not None and selected.get("kind") == "product"
        self.stock_quantity_input.setEnabled(stock)
        self.stock_reason_input.setEnabled(stock)
        self.stock_change_kind.setEnabled(stock)
        self.stock_button.setEnabled(stock)
        self.stock_change_button.setEnabled(stock)
        self.stock_history_button.setEnabled(
            selected is not None and selected.get("kind") == "product" and not self.busy
        )

    def confirm_leave(self) -> bool:
        if self.busy:
            self.status_label.setText("현재 요청의 결과를 확인한 뒤 닫아주세요.")
            return False
        if self._recovery is not None or self._recovery_invalid:
            return True
        return not self._dirty() or self._confirm_discard()

    def accept(self) -> None:
        if self.confirm_leave():
            super().accept()

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            event.accept()
        else:
            event.ignore()


class CustomerWalletDialog(QDialog):
    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        customer_id: UUID,
        parent: QWidget | None = None,
        *,
        can_manage: bool = False,
        recovery_store: Any = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id, self.customer_id = client, organization_id, customer_id
        self.can_manage = can_manage
        self.busy = True
        self.wallets: list[dict[str, object]] = []
        self._store = recovery_store or QSettings("BusinessAssistant", "wallet-lifecycle-recovery")
        identity = str(getattr(client, "payment_recovery_identity", "local-user"))
        self._key = (
            f"{sha256(identity.encode('utf-8')).hexdigest()}/{organization_id}/{customer_id}"
        )
        self._pending: dict[str, object] | None = None
        saved = self._store.value(self._key, "")
        if saved:
            try:
                pending = json.loads(str(saved))
                if not isinstance(pending, dict) or not isinstance(pending.get("payload"), dict):
                    raise ValueError("Invalid pending wallet action")
                UUID(str(pending["wallet_id"]))
                UUID(str(pending["payload"]["operation_id"]))
                self._pending = pending
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self._pending = {"invalid": True}
        self._worker: _Work | None = None
        self.setWindowTitle("고객 회원권 · 잔여 혜택")
        self.resize(720, 420)
        root = QVBoxLayout(self)
        title = QLabel("고객 회원권 · 잔여 혜택")
        title.setObjectName("page-title")
        root.addWidget(title)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(
            ["회원권", "잔여 금액", "잔여 횟수", "시작일", "만료일", "상태"]
        )
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.itemSelectionChanged.connect(self._controls)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.table)
        root.addWidget(self.table, 1)
        self.history = QTableWidget(0, 4)
        self.history.setHorizontalHeaderLabels(["사용일", "회원권", "사용", "적용 금액"])
        self.history.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.history)
        root.addWidget(self.history, 1)
        actions = QHBoxLayout()
        self.pause_button = QPushButton("정지")
        self.resume_button = QPushButton("재개")
        self.extend_button = QPushButton("기간 연장")
        self.retry_button = QPushButton("이전 요청 재확인")
        for button in (
            self.pause_button,
            self.resume_button,
            self.extend_button,
            self.retry_button,
        ):
            actions.addWidget(button)
        root.addLayout(actions)
        self.pause_button.clicked.connect(lambda: self._start_lifecycle("pause"))
        self.resume_button.clicked.connect(lambda: self._start_lifecycle("resume"))
        self.extend_button.clicked.connect(lambda: self._start_lifecycle("extend"))
        self.retry_button.clicked.connect(self._retry_lifecycle)
        self.status_label = QLabel("회원권을 불러오는 중…")
        root.addWidget(self.status_label)
        close_button = QPushButton("닫기")
        close_button.clicked.connect(self.accept)
        root.addWidget(close_button)
        self._load_wallets()

    def _load_wallets(self) -> None:
        self.busy = True
        self._controls()
        self._worker = _Work(
            "wallets",
            lambda: self.client.list_customer_wallets(self.organization_id, self.customer_id),
        )
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def _controls(self) -> None:
        selected = self.table.currentRow()
        wallet = self.wallets[selected] if 0 <= selected < len(self.wallets) else None
        enabled = self.can_manage and not self.busy and self._pending is None and wallet is not None
        self.pause_button.setEnabled(
            bool(enabled and wallet and wallet.get("lifecycle_status", "active") == "active")
        )
        self.resume_button.setEnabled(
            bool(enabled and wallet and wallet.get("lifecycle_status") == "paused")
        )
        self.extend_button.setEnabled(bool(enabled and wallet and wallet.get("expires_on")))
        self.retry_button.setEnabled(
            self.can_manage
            and not self.busy
            and bool(self._pending)
            and not bool(self._pending.get("invalid") if self._pending else False)
        )

    def _start_lifecycle(self, action: str) -> None:
        index = self.table.currentRow()
        if (
            self.busy
            or self._pending is not None
            or not self.can_manage
            or not 0 <= index < len(self.wallets)
        ):
            return
        wallet = self.wallets[index]
        days = None
        if action == "extend":
            days, ok = QInputDialog.getInt(self, "회원권 기간 연장", "연장할 일수", 7, 1, 3650)
            if not ok:
                return
        reason, ok = QInputDialog.getText(self, "회원권 변경", "변경 사유")
        if not ok or not reason.strip():
            return
        payload = {
            "action": action,
            "extend_days": days,
            "reason": reason.strip(),
            "expected_version": int(wallet.get("lifecycle_version", 1)),
            "operation_id": str(uuid4()),
        }
        pending = {"wallet_id": str(wallet["id"]), "payload": payload}
        self._store.setValue(self._key, json.dumps(pending, ensure_ascii=False))
        self._store.sync()
        if self._store.status() != QSettings.Status.NoError:
            self.status_label.setText("복구 정보를 저장하지 못해 변경을 시작하지 않았습니다.")
            return
        self._pending = pending
        self._retry_lifecycle()

    def _retry_lifecycle(self) -> None:
        if self.busy or self._pending is None or self._pending.get("invalid"):
            return
        pending = self._pending
        self.busy = True
        self._controls()
        self.status_label.setText("회원권 변경 결과를 확인하는 중…")
        self._worker = _Work(
            "lifecycle",
            lambda: self.client.manage_customer_wallet(
                self.organization_id,
                self.customer_id,
                UUID(str(pending["wallet_id"])),
                pending["payload"],
            ),
        )
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if kind == "lifecycle":
            if error is not None:
                self.status_label.setText("결과가 불명확합니다. 같은 요청을 재확인하세요.")
                self._controls()
                return
            self._store.remove(self._key)
            self._store.sync()
            self._pending = None
            self._load_wallets()
            return
        if error is not None:
            self.status_label.setText("회원권을 불러오지 못했습니다. 잠시 후 다시 확인하세요.")
            self._controls()
            return
        self.wallets = result
        self.table.setRowCount(len(result))
        for index, row in enumerate(result):
            values = (
                str(row.get("name_snapshot", "")),
                _money(row.get("money_balance", 0)),
                f"{row.get('count_balance', 0)}회",
                str(row.get("valid_from", "")),
                str(row.get("expires_on") or "기간 제한 없음"),
                "정지" if row.get("lifecycle_status") == "paused" else "사용 가능",
            )
            for column, value in enumerate(values):
                self.table.setItem(index, column, QTableWidgetItem(value))
        usages = [
            (row, usage)
            for row in result
            for usage in row.get("usage_history", [])
            if isinstance(usage, dict)
        ]
        usages.sort(key=lambda pair: str(pair[1].get("created_at", "")), reverse=True)
        self.history.setRowCount(len(usages))
        for index, (wallet, usage) in enumerate(usages):
            used = (
                "1회"
                if usage.get("mode") == "count"
                else _money(abs(int(str(usage.get("money_delta", "0")))))
            )
            history_values = (
                str(usage.get("created_at", ""))[:16].replace("T", " "),
                str(wallet.get("name_snapshot", "")),
                used,
                _money(usage.get("applied_amount", 0)),
            )
            for column, value in enumerate(history_values):
                self.history.setItem(index, column, QTableWidgetItem(value))
        self.status_label.setText(
            "결과가 불명확한 이전 요청이 있습니다. 재확인하세요."
            if self._pending
            else "보유 회원권이 없습니다."
            if not result
            else "결제 완료 기준 잔여 혜택입니다."
        )
        self._controls()


class WalletUseDialog(QDialog):
    """Apply one durable wallet usage to an active treatment line."""

    def __init__(
        self,
        client: Any,
        organization_id: UUID,
        customer_id: UUID,
        bundle: dict[str, object],
        *,
        can_manage: bool,
        parent: QWidget | None = None,
        recovery_store: Any = None,
    ) -> None:
        super().__init__(parent)
        self.client, self.organization_id, self.customer_id = client, organization_id, customer_id
        self.bundle = bundle
        self.can_manage = can_manage
        self.wallets: list[dict[str, object]] = []
        self.busy = False
        self._worker: _Work | None = None
        visit = bundle.get("visit", {})
        cart = bundle.get("cart", {})
        if not isinstance(visit, dict) or not isinstance(cart, dict):
            raise ValueError("Wallet use requires a visit cart")
        self.visit_id = UUID(str(visit["id"]))
        self.cart_version = int(cart["version"])
        self._store = recovery_store or QSettings("BusinessAssistant", "wallet-use-recovery")
        identity = str(getattr(client, "payment_recovery_identity", "local-user"))
        self._key = (
            f"{sha256(identity.encode('utf-8')).hexdigest()}/{organization_id}/{self.visit_id}"
        )
        self._pending: dict[str, object] | None = None
        self._uncertain = False
        self._recovery_invalid = False
        stored = self._store.value(self._key, "")
        if stored:
            try:
                pending = json.loads(str(stored))
                if not isinstance(pending, dict):
                    raise ValueError("Invalid wallet recovery")
                UUID(str(pending["wallet_id"]))
                UUID(str(pending["sale_line_id"]))
                UUID(str(pending["operation_id"]))
                if (
                    pending.get("mode") not in {"money", "count"}
                    or type(pending.get("expected_cart_version")) is not int
                    or int(pending["expected_cart_version"]) < 1
                    or pending.get("confirmed") is not True
                    or (
                        pending.get("mode") == "money"
                        and (
                            not isinstance(pending.get("amount"), str)
                            or re.fullmatch(r"[1-9][0-9]{0,11}", str(pending["amount"])) is None
                        )
                    )
                    or (pending.get("mode") == "count" and pending.get("amount") is not None)
                ):
                    raise ValueError("Invalid wallet recovery")
                self._pending = pending
                self._uncertain = True
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self._recovery_invalid = True

        self.setWindowTitle("회원권 사용")
        self.resize(820, 600)
        root = QVBoxLayout(self)
        title = QLabel("방문 시술에 회원권 사용")
        title.setObjectName("page-title")
        root.addWidget(title)
        note = QLabel(
            "금액권은 입력 금액을, 횟수권은 선택한 시술의 남은 금액 전체를 적용합니다. "
            "회원권 사용은 별도 현금 매출을 만들지 않습니다."
        )
        note.setWordWrap(True)
        root.addWidget(note)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["회원권", "잔여 금액", "잔여 횟수", "만료일"])
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.table)
        root.addWidget(self.table, 1)
        form = QFormLayout()
        self.line_input = QComboBox()
        lines = bundle.get("lines", [])
        for line in lines if isinstance(lines, list) else []:
            if (
                isinstance(line, dict)
                and line.get("status") == "active"
                and line.get("source_type") == "treatment_draft"
            ):
                description = line.get("description_snapshot", "시술")
                total = _money(line.get("line_total", 0))
                self.line_input.addItem(
                    f"{description} · {total}",
                    str(line.get("id")),
                )
        self.mode_input = QComboBox()
        self.mode_input.addItem("금액권 사용", "money")
        self.mode_input.addItem("횟수권 1회 사용", "count")
        self.amount_input = QLineEdit()
        self.amount_input.setPlaceholderText("사용할 금액 (원)")
        self.confirmed = QCheckBox("선택한 시술과 차감 혜택을 확인했습니다.")
        form.addRow("적용 시술", self.line_input)
        form.addRow("사용 방식", self.mode_input)
        form.addRow("사용 금액", self.amount_input)
        form.addRow(self.confirmed)
        root.addLayout(form)
        self.status_label = QLabel("회원권을 불러오는 중…")
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)
        buttons = QHBoxLayout()
        self.retry_button = QPushButton("미확인 사용 다시 확인")
        self.use_button = QPushButton("회원권 사용")
        self.use_button.setProperty("role", "primary")
        close = QPushButton("닫기")
        buttons.addWidget(self.retry_button)
        buttons.addStretch()
        buttons.addWidget(self.use_button)
        buttons.addWidget(close)
        root.addLayout(buttons)
        self.mode_input.currentIndexChanged.connect(self._controls)
        self.table.itemSelectionChanged.connect(self._controls)
        self.use_button.clicked.connect(self._use)
        self.retry_button.clicked.connect(self._retry)
        close.clicked.connect(self.reject)
        self._run("load", lambda: client.list_customer_wallets(organization_id, customer_id))

    def _run(self, kind: str, operation: Callable[[], Any]) -> None:
        if self.busy:
            return
        self.busy = True
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        kind, result, error = outcome
        self.busy = False
        if error is not None:
            status = (
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            )
            if kind == "use" and not self._uncertain and status in {400, 401, 403, 404, 409, 422}:
                self._clear_recovery()
                self.status_label.setText(
                    "회원권 사용이 거절되었습니다. 방문·잔액을 새로 확인해 주세요."
                )
            elif kind == "use" and self._pending:
                self._uncertain = True
                self.status_label.setText(
                    "사용 결과를 확인하지 못했습니다. 원래 계정으로 로그인한 뒤 "
                    "같은 요청을 다시 확인하세요."
                )
            else:
                self.status_label.setText("회원권을 불러오지 못했습니다. 다시 열어 확인해 주세요.")
            self._controls()
            return
        if kind == "load":
            self.wallets = result
            self._render()
            self.status_label.setText(
                "복구 정보가 손상되어 새 사용을 중지했습니다. 관리자에게 확인을 요청하세요."
                if self._recovery_invalid
                else "결과가 불명확한 사용 요청이 있습니다. 같은 요청을 다시 확인하세요."
                if self._pending
                else "사용할 회원권과 시술을 선택하세요."
                if result
                else "사용 가능한 회원권이 없습니다."
            )
        else:
            applied = dict(self._pending or {})
            self._clear_recovery()
            self.cart_version = int(result.get("cart_version", self.cart_version))
            if self._pending is None:
                wallet_id = str(applied.get("wallet_id", ""))
                for wallet in self.wallets:
                    if str(wallet.get("id")) != wallet_id:
                        continue
                    if applied.get("mode") == "money":
                        wallet["money_balance"] = str(
                            int(str(wallet.get("money_balance", 0)))
                            - int(str(applied.get("amount", 0)))
                        )
                    else:
                        wallet["count_balance"] = int(str(wallet.get("count_balance", 0))) - 1
                self.amount_input.clear()
                self.confirmed.setChecked(False)
                self._render()
            self.status_label.setText(
                "회원권 사용을 기록했습니다. 남은 방문 금액은 "
                f"{_money(result.get('outstanding_amount', 0))}입니다."
            )
        self._controls()

    def _render(self) -> None:
        self.table.setRowCount(len(self.wallets))
        for index, row in enumerate(self.wallets):
            values = (
                str(row.get("name_snapshot", "")),
                _money(row.get("money_balance", 0)),
                f"{row.get('count_balance', 0)}회",
                str(row.get("expires_on") or "기간 제한 없음"),
            )
            for column, value in enumerate(values):
                self.table.setItem(index, column, QTableWidgetItem(value))
        if self.wallets:
            self.table.selectRow(0)

    def _use(self) -> None:
        row = self.table.currentRow()
        if (
            not self.can_manage
            or self.busy
            or self._pending
            or self._recovery_invalid
            or not (0 <= row < len(self.wallets))
            or self.line_input.currentData() is None
        ):
            return
        wallet = self.wallets[row]
        if wallet.get("lifecycle_status") == "paused":
            self.status_label.setText("정지된 회원권입니다. 관리자에게 문의하세요.")
            return
        mode = str(self.mode_input.currentData())
        amount = self.amount_input.text().strip() if mode == "money" else None
        if mode == "money" and (
            amount is None
            or re.fullmatch(r"[1-9][0-9]{0,11}", amount) is None
            or int(amount) > int(str(wallet.get("money_balance", 0)))
        ):
            self.status_label.setText("잔여 금액 안에서 사용할 원 단위 금액을 입력하세요.")
            return
        if mode == "count" and int(str(wallet.get("count_balance", 0))) < 1:
            self.status_label.setText("남은 횟수가 없습니다.")
            return
        if not self.confirmed.isChecked():
            self.status_label.setText("선택한 시술과 차감 혜택을 확인해 주세요.")
            return
        payload: dict[str, object] = {
            "wallet_id": str(wallet["id"]),
            "sale_line_id": str(self.line_input.currentData()),
            "mode": mode,
            "amount": amount,
            "expected_cart_version": self.cart_version,
            "operation_id": str(uuid4()),
            "confirmed": True,
        }
        self._store.setValue(self._key, json.dumps(payload, ensure_ascii=False))
        self._store.sync()
        if self._store.status() != QSettings.Status.NoError:
            self.status_label.setText(
                "복구 정보를 저장하지 못해 회원권 사용을 시작하지 않았습니다."
            )
            return
        self._pending = payload
        self._uncertain = False
        self._retry()

    def _retry(self) -> None:
        if self.busy or not self.can_manage or not self._pending or self._recovery_invalid:
            return
        payload = dict(self._pending)
        self._run(
            "use",
            lambda: self.client.use_customer_wallet(self.organization_id, self.visit_id, payload),
        )

    def _clear_recovery(self) -> None:
        self._store.remove(self._key)
        self._store.sync()
        if self._store.status() == QSettings.Status.NoError:
            self._pending = None
            self._uncertain = False
        else:
            self._uncertain = True

    def _controls(self, *_args: object) -> None:
        editable = (
            self.can_manage
            and not self.busy
            and not self._pending
            and not self._recovery_invalid
            and bool(self.wallets)
            and self.line_input.count() > 0
        )
        self.table.setEnabled(not self.busy and not self._pending and not self._recovery_invalid)
        self.line_input.setEnabled(editable)
        self.mode_input.setEnabled(editable)
        self.amount_input.setEnabled(editable and self.mode_input.currentData() == "money")
        self.confirmed.setEnabled(editable)
        self.use_button.setEnabled(editable)
        self.retry_button.setVisible(bool(self._pending))
        self.retry_button.setEnabled(
            self.can_manage and not self.busy and not self._recovery_invalid
        )

    def confirm_leave(self) -> bool:
        if self.busy:
            self.status_label.setText("현재 요청의 결과를 확인한 뒤 닫아주세요.")
            return False
        if self._pending or self._recovery_invalid:
            return True
        if self.amount_input.text() or self.confirmed.isChecked():
            return (
                QMessageBox.question(
                    self,
                    "작성 중인 회원권 사용",
                    "입력한 회원권 사용 내용을 버릴까요?",
                    QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                    QMessageBox.StandardButton.Cancel,
                )
                == QMessageBox.StandardButton.Discard
            )
        return True

    def reject(self) -> None:
        if self.confirm_leave():
            super().reject()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.confirm_leave():
            event.accept()
        else:
            event.ignore()


def _money(value: object) -> str:
    try:
        return f"{int(str(value)):,.0f}원"
    except (TypeError, ValueError):
        return "금액 확인 필요"
