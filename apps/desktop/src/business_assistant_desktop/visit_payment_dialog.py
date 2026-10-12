"""Receipt recording with durable retry identity and protected input."""

# ruff: noqa: E501, E701, E702

import json
import re
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from hashlib import sha256
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QSettings, QThreadPool, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
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
        self.refund_button = QPushButton("환불 · 사용 취소")
        self.product_return_button = QPushButton("상품 반품")
        self.save_button = QPushButton("수납 기록 저장")
        self.save_button.setProperty("role", "primary")
        close = QPushButton("닫기")
        for button in (
            self.refresh_button,
            self.retry_button,
            self.refund_button,
            self.product_return_button,
            self.save_button,
            close,
        ):
            button.setAutoDefault(False)
            buttons.addWidget(button)
        root.addLayout(buttons)
        self.refresh_button.clicked.connect(self.reload)
        self.save_button.clicked.connect(self._save)
        self.retry_button.clicked.connect(self._retry)
        self.refund_button.clicked.connect(self._open_refunds)
        self.product_return_button.clicked.connect(self._open_product_returns)
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
        if result.get("status") == "void":
            self.balance_label.setText(
                f"청구 {_money(result['total_amount'])}  ·  "
                f"순수납 {_money(result['paid_amount'])}  ·  "
                f"환불 {_money(result.get('refunded_amount', 0))}  ·  "
                f"취소 잔액 {_money(result['outstanding_amount'])}"
            )
        else:
            self.balance_label.setText(
                f"청구 {_money(result['total_amount'])}  ·  "
                f"수납 {_money(result['paid_amount'])}  ·  "
                f"미수 {_money(result['outstanding_amount'])}"
            )
        receipts = result.get("receipts", [])
        self.history.setRowCount(len(receipts))
        labels = {"cash": "현금", "card": "카드", "transfer": "이체", "wallet": "회원권"}
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
        self.refund_button.setEnabled(not self.busy and self.snapshot is not None)
        self.product_return_button.setEnabled(not self.busy and self.snapshot is not None)

    def _open_refunds(self):
        if self.busy or self.snapshot is None:
            return
        dialog = VisitRefundDialog(
            self.client,
            self.organization_id,
            self.visit_id,
            can_manage=self.can_manage,
            recovery_identity=self._key.split("/", 1)[0],
            parent=self,
        )
        dialog.exec()
        self.reload()

    def _open_product_returns(self):
        if self.busy or self.snapshot is None:
            return
        dialog = VisitProductReturnDialog(
            self.client, self.organization_id, self.visit_id,
            can_manage=self.can_manage,
            recovery_identity=self._key.split("/", 1)[0],
            parent=self,
        )
        dialog.exec()
        self.reload()

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


class VisitRefundDialog(QDialog):
    def __init__(
        self,
        client,
        organization_id,
        visit_id,
        *,
        can_manage,
        recovery_identity,
        parent=None,
        recovery_store=None,
    ):
        super().__init__(parent)
        self.client, self.organization_id, self.visit_id = client, organization_id, visit_id
        self.can_manage, self.busy, self.snapshot = can_manage, False, None
        self._worker = None
        self._store = recovery_store or QSettings("BusinessAssistant", "refund-recovery")
        self._key = f"{recovery_identity}/{organization_id}/{visit_id}"
        self._pending, self._uncertain, self._recovery_invalid = None, False, False
        stored = self._store.value(self._key, "")
        if stored:
            try:
                pending = json.loads(str(stored))
                UUID(str(pending["source_id"]));UUID(str(pending["operation_id"]))
                if (
                    not isinstance(pending.get("amount"), str)
                    or re.fullmatch(r"[1-9][0-9]{0,11}", pending["amount"]) is None
                    or not isinstance(pending.get("reason"), str)
                    or not pending["reason"].strip()
                    or type(pending.get("expected_version")) is not int
                    or pending["expected_version"] < 1
                    or pending.get("confirmed") is not True
                ):
                    raise ValueError("Invalid refund recovery")
                self._pending, self._uncertain = pending, True
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self._recovery_invalid = True
        self.setWindowTitle("환불 · 회원권 사용 취소")
        self.resize(760, 520)
        root = QVBoxLayout(self)
        title = QLabel("원거래 참조 환불")
        title.setObjectName("page-title");root.addWidget(title)
        note = QLabel("외부 카드사·은행 취소를 실행하지 않습니다. 실제 취소를 확인한 뒤 기록하세요.")
        note.setWordWrap(True);root.addWidget(note)
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["수단", "원금", "환불됨", "환불 가능", "원거래"])
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers);polish_table(self.table)
        root.addWidget(self.table, 1)
        form = QGridLayout();self.amount_input=QLineEdit();self.reason_input=QLineEdit()
        self.amount_input.setPlaceholderText("환불 금액 (원)");self.reason_input.setPlaceholderText("환불 사유")
        form.addWidget(QLabel("환불 금액"),0,0);form.addWidget(self.amount_input,0,1)
        form.addWidget(QLabel("사유"),1,0);form.addWidget(self.reason_input,1,1);root.addLayout(form)
        self.confirmed=QCheckBox("외부 취소 여부와 환불 대상을 확인했습니다.");root.addWidget(self.confirmed)
        self.status_label=QLabel("수납·환불 내역을 불러오는 중…");self.status_label.setWordWrap(True);root.addWidget(self.status_label)
        buttons=QHBoxLayout();self.retry_button=QPushButton("미확인 환불 다시 확인");self.save_button=QPushButton("환불 기록")
        self.save_button.setProperty("role","primary");close=QPushButton("닫기")
        buttons.addWidget(self.retry_button);buttons.addStretch();buttons.addWidget(self.save_button);buttons.addWidget(close);root.addLayout(buttons)
        self.retry_button.clicked.connect(self._retry);self.save_button.clicked.connect(self._save);close.clicked.connect(self.reject)
        self._run("load",lambda:client.get_visit_payments(organization_id,visit_id))

    def _run(self,kind,operation):
        if self.busy:return
        self.busy=True;self._controls();self._worker=_Work(kind,operation);self._worker.signals.finished.connect(self._finished);QThreadPool.globalInstance().start(self._worker)

    def _finished(self,outcome):
        kind,result,error=outcome;self.busy=False
        if error:
            status=error.response.status_code if isinstance(error,httpx.HTTPStatusError) else None
            if kind=="refund" and not self._uncertain and status in {400,401,403,404,409,422}:
                self._clear();self.status_label.setText("환불 기록이 거절되었습니다. 최신 내역을 다시 확인하세요.")
            elif kind=="refund" and self._pending:
                self._uncertain=True;self.status_label.setText("환불 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.")
            else:self.status_label.setText("내역을 불러오지 못했습니다.")
            self._controls();return
        self.snapshot=result
        if kind=="refund":self._clear();self.amount_input.clear();self.reason_input.clear();self.confirmed.setChecked(False)
        self._render();self.status_label.setText("환불 내역을 확인했습니다." if kind=="load" else "환불 반대 원장을 기록했습니다.");self._controls()

    def _render(self):
        receipts=self.snapshot.get("receipts",[]) if self.snapshot else [];refunds=self.snapshot.get("refunds",[]) if self.snapshot else []
        totals={}
        for refund in refunds:totals[str(refund.get("source_id"))]=totals.get(str(refund.get("source_id")),0)+int(str(refund.get("amount",0)))
        self.table.setRowCount(len(receipts));labels={"cash":"현금","card":"카드","transfer":"이체","wallet":"회원권"}
        for row,receipt in enumerate(receipts):
            original=int(str(receipt.get("amount",0)));done=totals.get(str(receipt.get("id")),0);available=max(original-done,0)
            vals=(labels.get(receipt.get("method"),str(receipt.get("method"))),_money(original),_money(done),_money(available),str(receipt.get("reference",'')))
            for col,val in enumerate(vals):self.table.setItem(row,col,QTableWidgetItem(val))
        if receipts:self.table.selectRow(0)

    def _save(self):
        row=self.table.currentRow();receipts=self.snapshot.get("receipts",[]) if self.snapshot else []
        if not self.can_manage or self.busy or self._pending or self._recovery_invalid or not(0<=row<len(receipts)):return
        amount=self.amount_input.text().strip();reason=self.reason_input.text().strip()
        if re.fullmatch(r"[1-9][0-9]{0,11}",amount) is None or not reason or len(reason)>1000 or not self.confirmed.isChecked():
            self.status_label.setText("환불 금액, 사유와 확인 항목을 확인하세요.");return
        receipt=receipts[row];refunded=sum(int(str(item.get("amount",0))) for item in self.snapshot.get("refunds",[]) if str(item.get("source_id"))==str(receipt.get("id")))
        available=int(str(receipt.get("amount",0)))-refunded
        if int(amount)>available or (receipt.get("method")=="wallet" and int(amount)!=available):
            self.status_label.setText("원거래의 환불 가능 금액 안에서 입력하세요. 회원권 사용은 전체 취소만 가능합니다.");return
        payload={"source_id":str(receipt["id"]),"amount":amount,"reason":reason,"expected_version":int(self.snapshot["cart_version"]),"operation_id":str(uuid4()),"confirmed":True}
        self._store.setValue(self._key,json.dumps(payload,ensure_ascii=False));self._store.sync()
        if self._store.status()!=QSettings.Status.NoError:self.status_label.setText("복구 정보를 저장하지 못해 환불을 시작하지 않았습니다.");return
        self._pending=payload;self._uncertain=False;self._retry()

    def _retry(self):
        if self.busy or not self.can_manage or not self._pending or self._recovery_invalid:return
        payload=dict(self._pending);self._run("refund",lambda:self.client.refund_visit_payment(self.organization_id,self.visit_id,payload))

    def _clear(self):
        self._store.remove(self._key);self._store.sync()
        if self._store.status()==QSettings.Status.NoError:self._pending=None;self._uncertain=False
        else:self._uncertain=True

    def _controls(self):
        editable=self.can_manage and not self.busy and not self._pending and not self._recovery_invalid and self.snapshot is not None
        self.table.setEnabled(editable);self.amount_input.setEnabled(editable);self.reason_input.setEnabled(editable);self.confirmed.setEnabled(editable);self.save_button.setEnabled(editable)
        self.retry_button.setVisible(bool(self._pending));self.retry_button.setEnabled(self.can_manage and not self.busy and not self._recovery_invalid)

    def confirm_leave(self):
        if self.busy:return False
        if self._pending or self._recovery_invalid:return True
        if not(self.amount_input.text() or self.reason_input.text() or self.confirmed.isChecked()):return True
        return QMessageBox.question(self,"작성 중인 환불","입력한 환불 내용을 버릴까요?",QMessageBox.StandardButton.Discard|QMessageBox.StandardButton.Cancel,QMessageBox.StandardButton.Cancel)==QMessageBox.StandardButton.Discard

    def reject(self):
        if self.confirm_leave():super().reject()


class VisitProductReturnDialog(QDialog):
    def __init__(self, client, organization_id, visit_id, *, can_manage, recovery_identity, parent=None, recovery_store=None):
        super().__init__(parent)
        self.client, self.organization_id, self.visit_id = client, organization_id, visit_id
        self.can_manage, self.busy, self.cart, self.payments = can_manage, False, None, None
        self._worker = None
        self._store = recovery_store or QSettings("BusinessAssistant", "product-return-recovery")
        self._key = f"{recovery_identity}/{organization_id}/{visit_id}"
        self._pending, self._recovery_invalid = None, False
        stored = self._store.value(self._key, "")
        if stored:
            try:
                self._pending = json.loads(str(stored))
                UUID(str(self._pending["operation_id"]))
                UUID(str(self._pending["sale_line_id"]))
                UUID(str(self._pending["receipt_id"]))
                if (type(self._pending.get("quantity")) is not int or self._pending["quantity"] < 1
                    or self._pending["quantity"] > 999
                    or type(self._pending.get("restock")) is not bool
                    or re.fullmatch(r"[1-9][0-9]{0,11}", str(self._pending.get("amount", ""))) is None
                    or not str(self._pending.get("reason", "")).strip()
                    or type(self._pending.get("expected_version")) is not int
                    or self._pending.get("confirmed") is not True):
                    raise ValueError("Invalid product return recovery")
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self._pending, self._recovery_invalid = None, True
        self.setWindowTitle("고객 상품 반품 · 환불")
        self.resize(760, 560)
        root = QVBoxLayout(self)
        title = QLabel("판매 상품 반품")
        title.setObjectName("page-title")
        root.addWidget(title)
        note = QLabel("반품 수량, 원결제 수단의 환불 금액, 재입고 여부를 함께 기록합니다. 실제 카드·은행 취소는 별도로 완료한 뒤 진행하세요.")
        note.setWordWrap(True)
        root.addWidget(note)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["상품", "판매", "반품", "반품 가능"])
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        polish_table(self.table)
        root.addWidget(self.table, 1)
        form = QGridLayout()
        self.line_select, self.receipt_select = QComboBox(), QComboBox()
        self.quantity = QSpinBox(); self.quantity.setRange(1, 999)
        self.amount_input, self.reason_input = QLineEdit(), QLineEdit()
        self.amount_input.setPlaceholderText("환불 금액 (원)"); self.amount_input.setMaxLength(12)
        self.reason_input.setPlaceholderText("반품 사유")
        self.restock = QCheckBox("반품 상품 재입고")
        self.restock.setChecked(True)
        form.addWidget(QLabel("상품"), 0, 0); form.addWidget(self.line_select, 0, 1)
        form.addWidget(QLabel("원결제"), 1, 0); form.addWidget(self.receipt_select, 1, 1)
        form.addWidget(QLabel("반품 수량"), 2, 0); form.addWidget(self.quantity, 2, 1)
        form.addWidget(QLabel("환불 금액"), 3, 0); form.addWidget(self.amount_input, 3, 1)
        form.addWidget(QLabel("사유"), 4, 0); form.addWidget(self.reason_input, 4, 1)
        form.addWidget(self.restock, 5, 1)
        root.addLayout(form)
        self.confirmed = QCheckBox("반품 상품과 원결제 환불 처리, 실제 외부 취소 상태를 확인했습니다.")
        root.addWidget(self.confirmed)
        self.status_label = QLabel("판매·수납 내역을 불러오는 중…")
        self.status_label.setWordWrap(True); root.addWidget(self.status_label)
        buttons = QHBoxLayout()
        self.retry_button, self.save_button, close = QPushButton("미확인 반품 다시 확인"), QPushButton("반품·환불 기록"), QPushButton("닫기")
        self.save_button.setProperty("role", "primary")
        buttons.addWidget(self.retry_button); buttons.addStretch(); buttons.addWidget(self.save_button); buttons.addWidget(close)
        root.addLayout(buttons)
        self.retry_button.clicked.connect(self._retry); self.save_button.clicked.connect(self._save); close.clicked.connect(self.reject)
        self._run("load", self._load_data)

    def _load_data(self):
        return (self.client.get_sale_cart(self.organization_id, self.visit_id),
                self.client.get_visit_payments(self.organization_id, self.visit_id))

    def _run(self, kind, operation):
        if self.busy: return
        self.busy = True; self._controls(); self._worker = _Work(kind, operation)
        self._worker.signals.finished.connect(self._finished); QThreadPool.globalInstance().start(self._worker)

    def _finished(self, outcome):
        kind, result, error = outcome; self.busy = False
        if error:
            status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
            if kind == "return" and status in {400, 401, 403, 404, 409, 422}:
                self._clear(); self.status_label.setText("반품 기록이 거절되었습니다. 최신 내역을 다시 확인하세요.")
            elif kind == "return" and self._pending:
                self.status_label.setText("반품 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.")
            else: self.status_label.setText("판매·수납 내역을 불러오지 못했습니다.")
            self._controls(); return
        if kind == "load":
            self.cart, self.payments = result
            if self._pending:
                self._retry()
                return
            self._render()
            self.status_label.setText("반품 가능한 상품과 원결제 내역을 확인했습니다.")
        else:
            self.payments = result
            self._clear()
            if self._pending is not None:
                self.status_label.setText("반품은 저장됐습니다. 복구 정보를 지우지 못해 동일 요청 확인이 필요합니다.")
                self._controls()
                return
            self.amount_input.clear(); self.reason_input.clear(); self.confirmed.setChecked(False)
            self._run("load", self._load_data); return
        self._controls()

    def _render(self):
        lines = [line for line in self.cart.get("lines", []) if line.get("source_type") == "product" and line.get("status") == "active"]
        self.table.setRowCount(len(lines)); self.line_select.clear()
        self._lines = []
        for row, line in enumerate(lines):
            sold, returned = int(line.get("quantity", 0)), int(line.get("returned_quantity", 0))
            remaining = max(sold - returned, 0); self._lines.append(line)
            for col, value in enumerate((line.get("description_snapshot", "상품"), str(sold), str(returned), str(remaining))):
                self.table.setItem(row, col, QTableWidgetItem(value))
            if remaining:
                self.line_select.addItem(f"{line.get('description_snapshot', '상품')} · 최대 {remaining}개", line)
        self.receipt_select.clear()
        refunds = self.payments.get("refunds", [])
        refunded = {}
        for refund in refunds:
            refunded[str(refund.get("source_id"))] = refunded.get(str(refund.get("source_id")), 0) + int(str(refund.get("amount", 0)))
        labels = {"cash": "현금", "card": "카드", "transfer": "이체"}
        for receipt in self.payments.get("receipts", []):
            remaining = int(str(receipt.get("amount", 0))) - refunded.get(str(receipt.get("id")), 0)
            if receipt.get("method") in labels and remaining > 0:
                self.receipt_select.addItem(f"{labels[receipt['method']]} · 잔여 {_money(remaining)}원 · {receipt.get('reference', '')}", (receipt, remaining))
        if self.table.rowCount(): self.table.selectRow(0)

    def _save(self):
        if not self.can_manage or self.busy or self._pending or self._recovery_invalid or not self.cart or not self.payments: return
        line, receipt_data = self.line_select.currentData(), self.receipt_select.currentData()
        if not line or not receipt_data: self.status_label.setText("반품 가능한 상품과 환불 가능한 원결제 내역이 필요합니다."); return
        receipt, available = receipt_data
        amount, reason = self.amount_input.text().strip(), self.reason_input.text().strip()
        quantity = self.quantity.value(); returned = int(line.get("returned_quantity", 0))
        sold = int(line.get("quantity", 0))
        discount_share = Decimal(str(line.get("discount_share", "0")))
        prior_discount = Decimal(str(line.get("returned_discount_amount", "0")))
        after_quantity = returned + quantity
        discount_after = (
            discount_share
            if after_quantity == sold
            else (discount_share * after_quantity / sold).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        )
        discount_increment = discount_after - prior_discount
        remaining_net_value = (
            Decimal(str(line.get("line_total", "0"))) - discount_share
            - Decimal(str(line.get("returned_refund_amount", "0")))
        )
        return_limit = min(
            Decimal(str(line.get("unit_price", "0"))) * quantity - discount_increment,
            remaining_net_value,
        )
        if quantity > sold - returned or re.fullmatch(r"[1-9][0-9]{0,11}", amount) is None or int(amount) > available or int(amount) > return_limit or not reason or not self.confirmed.isChecked():
            self.status_label.setText("반품 수량, 원결제 잔액, 상품 금액, 사유와 확인 항목을 점검하세요."); return
        payload = {"sale_line_id": str(line["id"]), "receipt_id": str(receipt["id"]), "quantity": quantity,
                   "restock": self.restock.isChecked(), "amount": amount, "reason": reason,
                   "expected_version": int(self.cart["cart"]["version"]), "operation_id": str(uuid4()), "confirmed": True}
        self._store.setValue(self._key, json.dumps(payload, ensure_ascii=False)); self._store.sync()
        if self._store.status() != QSettings.Status.NoError: self.status_label.setText("복구 정보를 저장하지 못해 반품 요청을 시작하지 않았습니다."); return
        self._pending = payload; self._retry()

    def _retry(self):
        if self.busy or not self.can_manage or not self._pending or self._recovery_invalid: return
        payload = dict(self._pending)
        self._run("return", lambda: self.client.return_visit_product(self.organization_id, self.visit_id, payload))

    def _clear(self):
        self._store.remove(self._key); self._store.sync()
        if self._store.status() == QSettings.Status.NoError: self._pending = None

    def _controls(self):
        editable = self.can_manage and not self.busy and not self._pending and not self._recovery_invalid and self.cart is not None
        for widget in (self.table, self.line_select, self.receipt_select, self.quantity, self.amount_input, self.reason_input, self.restock, self.confirmed, self.save_button): widget.setEnabled(editable)
        self.retry_button.setVisible(bool(self._pending)); self.retry_button.setEnabled(self.can_manage and not self.busy and not self._recovery_invalid)

    def confirm_leave(self):
        if self.busy: return False
        if self._pending or self._recovery_invalid: return True
        if not (self.amount_input.text() or self.reason_input.text() or self.confirmed.isChecked()): return True
        return QMessageBox.question(self, "작성 중인 반품", "입력한 반품 내용을 버릴까요?", QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel, QMessageBox.StandardButton.Cancel) == QMessageBox.StandardButton.Discard

    def reject(self):
        if self.confirm_leave(): super().reject()
