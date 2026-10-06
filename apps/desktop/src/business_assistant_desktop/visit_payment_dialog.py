"""Receipt recording with durable retry identity and protected input."""

import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from hashlib import sha256
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QSettings, QThreadPool, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from business_assistant_desktop.sale_cart_page import _money, _Work
from business_assistant_desktop.ui_components import polish_table


class VisitPaymentDialog(QDialog):
    recorded = Signal()

    def __init__(
        self,
        client,
        organization_id: UUID,
        visit_id: UUID,
        *,
        can_manage: bool,
        parent=None,
        recovery_store=None,
        recovery_identity: str,
    ):
        super().__init__(parent)
        self.client, self.organization_id, self.visit_id = client, organization_id, visit_id
        self.can_manage = can_manage
        self.busy = False
        self.snapshot = None
        self._needs_refresh = False
        self._worker = None
        self._store = recovery_store or QSettings("BusinessAssistant", "payment-recovery")
        identity_hash = sha256(recovery_identity.encode("utf-8")).hexdigest()
        self._key = f"{identity_hash}/{organization_id}/{visit_id}"
        self._pending = None
        self._uncertain = False
        stored = self._store.value(self._key, "")
        self._recovery_invalid = False
        if stored:
            try:
                self._pending = json.loads(str(stored))
                UUID(self._pending["operation_id"])
                if (
                    not isinstance(self._pending["payments"], list)
                    or not 1 <= len(self._pending["payments"]) <= 3
                    or type(self._pending["expected_version"]) is not int
                    or self._pending["expected_version"] < 1
                    or self._pending.get("confirmed") is not True
                ):
                    raise ValueError("Invalid recovery")
                for part in self._pending["payments"]:
                    if (
                        part.get("method") not in {"cash", "card", "transfer"}
                        or not isinstance(part.get("amount"), str)
                        or not re.fullmatch(r"[1-9][0-9]{0,11}", part["amount"])
                        or not isinstance(part.get("reference"), str)
                    ):
                        raise ValueError("Invalid recovery payment")
                self._uncertain = True
            except (ValueError, KeyError, TypeError, AttributeError):
                self._pending = None
                self._recovery_invalid = True
        self.setWindowTitle("수납 기록 · 부분 수금")
        self.resize(760, 650)
        root = QVBoxLayout(self)
        title = QLabel("수납 기록")
        title.setObjectName("page-title")
        root.addWidget(title)
        note = QLabel(
            "실제로 받은 금액만 기록하세요. 카드 승인이나 계좌 이체를 실행하는 기능은 아닙니다.\n"
            "첫 수납 이후에는 청구 항목을 변경할 수 없습니다. 금액은 원 단위입니다."
        )
        note.setWordWrap(True)
        root.addWidget(note)
        self.balance_label = QLabel("수납 내역을 불러오는 중…")
        root.addWidget(self.balance_label)
        self.inputs = {}
        grid = QGridLayout()
        for row, (method, label) in enumerate(
            (("cash", "현금"), ("card", "카드"), ("transfer", "이체"))
        ):
            amount, reference = QLineEdit(), QLineEdit()
            amount.setPlaceholderText("받은 금액 (원)")
            amount.setMaxLength(12)
            reference.setPlaceholderText(
                "메모 (선택)" if method == "cash" else "승인번호 / 이체 식별번호 (필수)"
            )
            reference.setMaxLength(200)
            grid.addWidget(QLabel(label), row, 0)
            grid.addWidget(amount, row, 1)
            grid.addWidget(reference, row, 2)
            self.inputs[method] = (amount, reference)
        root.addLayout(grid)
        self.confirmed = QCheckBox("위 금액을 실제로 받았음을 확인했습니다.")
        root.addWidget(self.confirmed)
        self.history = QTableWidget(0, 4)
        self.history.setHorizontalHeaderLabels(["수납일 (한국시간)", "수단", "금액", "확인 번호"])
        self.history.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.history)
        root.addWidget(self.history, 1)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)
        buttons = QHBoxLayout()
        self.refresh_button = QPushButton("내역 새로고침")
        self.retry_button = QPushButton("미확인 수납 다시 확인")
        self.save_button = QPushButton("수납 기록 저장")
        self.save_button.setProperty("role", "primary")
        close = QPushButton("닫기")
        for button in (self.refresh_button, self.retry_button, self.save_button, close):
            button.setAutoDefault(False)
            buttons.addWidget(button)
        root.addLayout(buttons)
        self.refresh_button.clicked.connect(self.reload)
        self.save_button.clicked.connect(self._save)
        self.retry_button.clicked.connect(self._retry)
        close.clicked.connect(self.reject)
        if self._pending:
            for part in self._pending.get("payments", []):
                if isinstance(part, dict) and part.get("method") in self.inputs:
                    amount, reference = self.inputs[part["method"]]
                    amount.setText(str(part.get("amount", "")))
                    reference.setText(str(part.get("reference", "")))
        self._run(
            "load", lambda: self.client.get_visit_payments(self.organization_id, self.visit_id)
        )

    def _dirty(self):
        return self.confirmed.isChecked() or any(
            field.text() for pair in self.inputs.values() for field in pair
        )

    def _discard(self):
        return (
            not self._dirty()
            or QMessageBox.question(
                self,
                "작성 중인 수납",
                "저장하지 않은 입력을 버릴까요?",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Discard
        )

    def reload(self):
        if self.busy or self._pending or self._recovery_invalid or not self._discard():
            return
        self._run(
            "load", lambda: self.client.get_visit_payments(self.organization_id, self.visit_id)
        )

    def _run(self, kind, operation):
        if self.busy:
            return
        self.busy = True
        self._controls()
        self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(self._worker)

    def _save(self):
        if (
            self.busy
            or self._pending
            or self._recovery_invalid
            or self._needs_refresh
            or not self.can_manage
        ):
            return
        if not self.snapshot or self.snapshot.get("status") not in {"ready", "collecting"}:
            return
        total = Decimal(str(self.snapshot["total_amount"]))
        if total != total.to_integral_value():
            self.status_label.setText("원 미만 청구액이 있습니다. 장바구니에서 금액을 정정하세요.")
            return
        payments = []
        for method, (amount, reference) in self.inputs.items():
            text = amount.text().strip()
            ref = reference.text().strip()
            if not text:
                if ref:
                    self.status_label.setText("확인 번호를 입력한 수단의 금액도 입력하세요.")
                    return
                continue
            if not re.fullmatch(r"[1-9][0-9]{0,11}", text):
                self.status_label.setText("금액은 0보다 큰 원 단위 숫자로 입력하세요.")
                return
            if method != "cash" and not ref:
                self.status_label.setText("카드 승인번호 또는 이체 식별번호가 필요합니다.")
                return
            payments.append(dict(method=method, amount=text, reference=ref))
        if not payments or not self.confirmed.isChecked():
            self.status_label.setText("금액을 입력하고 실제 수납 확인을 체크하세요.")
            return
        if sum(Decimal(p["amount"]) for p in payments) > Decimal(
            str(self.snapshot["outstanding_amount"])
        ):
            self.status_label.setText("입력한 수납액이 남은 미수금보다 큽니다.")
            return
        payload = dict(
            operation_id=str(uuid4()),
            expected_version=self.snapshot["cart_version"],
            payments=payments,
            confirmed=True,
        )
        self._store.setValue(self._key, json.dumps(payload, ensure_ascii=False))
        self._store.sync()
        if self._store.status() != QSettings.Status.NoError:
            self.status_label.setText("수납 복구 정보를 보관하지 못해 저장을 시작하지 않았습니다.")
            return
        self._pending = payload
        self._retry()

    def _retry(self):
        if self.busy or not self.can_manage or not self._pending or self._recovery_invalid:
            return
        payload = dict(self._pending)
        self._run(
            "record",
            lambda: self.client.record_visit_payment(self.organization_id, self.visit_id, payload),
        )

    def _finished(self, outcome):
        kind, result, error = outcome
        self.busy = False
        if error:
            status = (
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            )
            if (
                kind == "record"
                and not self._uncertain
                and status in {400, 401, 403, 404, 409, 422}
            ):
                self._clear_recovery()
                self._needs_refresh = True
                self.status_label.setText(
                    "수납이 거절되었습니다. 입력은 유지했습니다. "
                    "권한·금액·확인 번호를 확인하고 내역을 새로고침하세요."
                )
            elif self._pending:
                self._uncertain = True
                self.status_label.setText(
                    "수납 결과가 아직 확인되지 않았습니다. "
                    "원래 계정으로 로그인한 뒤 ‘미확인 수납 다시 확인’을 눌러주세요."
                )
            else:
                self.status_label.setText("내역을 불러오지 못했습니다. 다시 조회해 주세요.")
            self._controls()
            return
        self.snapshot = result
        self._needs_refresh = False
        if kind == "record":
            self._clear_recovery()
            self.recorded.emit()
        if not self._pending:
            for pair in self.inputs.values():
                for field in pair:
                    field.clear()
            self.confirmed.setChecked(False)
        self.balance_label.setText(
            f"청구 {_money(result['total_amount'])}  ·  "
            f"수납 {_money(result['paid_amount'])}  ·  "
            f"미수 {_money(result['outstanding_amount'])}"
        )
        receipts = result.get("receipts", [])
        self.history.setRowCount(len(receipts))
        labels = {"cash": "현금", "card": "카드", "transfer": "이체"}
        for row, receipt in enumerate(receipts):
            values = (
                datetime.fromisoformat(str(receipt["received_at"]).replace("Z", "+00:00"))
                .astimezone(timezone(timedelta(hours=9)))
                .strftime("%Y-%m-%d %H:%M"),
                labels.get(receipt["method"], receipt["method"]),
                _money(receipt["amount"]),
                receipt.get("reference", ""),
            )
            for column, value in enumerate(values):
                self.history.setItem(row, column, QTableWidgetItem(str(value)))
        self.status_label.setText(
            "미확인 수납 기록이 있습니다. 같은 요청으로 결과를 확인하세요."
            if self._pending
            else "수납 내역을 확인했습니다."
        )
        if self._recovery_invalid:
            self.status_label.setText(
                "보관된 수납 복구 정보를 읽을 수 없어 새 수납을 잠갔습니다. "
                "관리자 점검이 필요합니다."
            )
        self._controls()

    def _clear_recovery(self):
        self._store.remove(self._key)
        self._store.sync()
        if self._store.status() == QSettings.Status.NoError:
            self._pending = None
            self._uncertain = False
        else:
            # Keep the identity in memory as well if durable cleanup was not confirmed.
            self._uncertain = True

    def _controls(self):
        editable = (
            self.can_manage and not self.busy and not self._pending and not self._recovery_invalid
        )
        valid_cart = self.snapshot is not None and self.snapshot.get("status") in {
            "ready",
            "collecting",
        }
        for pair in self.inputs.values():
            for field in pair:
                field.setEnabled(editable and valid_cart)
        self.confirmed.setEnabled(editable and valid_cart)
        self.save_button.setEnabled(editable and valid_cart and not self._needs_refresh)
        self.refresh_button.setEnabled(
            not self.busy and not self._pending and not self._recovery_invalid
        )
        self.retry_button.setVisible(bool(self._pending))
        self.retry_button.setEnabled(
            self.can_manage and not self.busy and not self._recovery_invalid
        )

    def confirm_leave(self):
        if self.busy:
            self.status_label.setText("현재 요청이 끝난 뒤 닫아주세요.")
            return False
        if self._pending:
            # Request identity is already durable; reopening must recover it before new collection.
            return True
        return self._discard()

    def reject(self):
        if self.confirm_leave():
            super().reject()

    def accept(self):
        if self.confirm_leave():
            super().accept()

    def closeEvent(self, event):
        if self.confirm_leave():
            event.accept()
        else:
            event.ignore()
