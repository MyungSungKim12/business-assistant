"""Asynchronous customer treatment record workspace."""

from collections.abc import Callable
from datetime import date
from typing import Any, Protocol
from uuid import UUID, uuid4

import httpx
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal, Slot
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.api_client import Customer, Treatment
from business_assistant_desktop.consultation_dialog import ConsultationDialog, consultation_ready
from business_assistant_desktop.document_issuance_dialog import (
    DocumentIssuanceDialog,
    IssuanceClient,
)
from business_assistant_desktop.sales_draft_dialog import SalesDraftDialog
from business_assistant_desktop.treatment_form import TreatmentForm, valid_date
from business_assistant_desktop.treatment_lifecycle import (
    STATUS_LABELS,
    TreatmentEventsDialog,
    TreatmentLifecycle,
)


class TreatmentClient(IssuanceClient, Protocol):
    def mutate_treatment(
        self, organization_id: UUID, customer_id: UUID, record_id: UUID, values: dict[str, object]
    ) -> Treatment: ...
    def list_treatment_events(
        self, organization_id: UUID, customer_id: UUID, record_id: UUID
    ) -> list[dict[str, object]]: ...
    def list_customers(self, organization_id: UUID) -> list[Customer]: ...
    def list_treatments(self, organization_id: UUID, customer_id: UUID) -> list[Treatment]: ...
    def create_treatment(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> Treatment: ...
    def update_treatment(
        self, organization_id: UUID, customer_id: UUID, record_id: UUID, values: dict[str, object]
    ) -> Treatment: ...


class _Signals(QObject):
    finished = Signal(object)


class _Request(QRunnable):
    def __init__(self, kind: str, generation: int, operation: Callable[[], Any]) -> None:
        super().__init__()
        self.kind, self.generation, self.operation = kind, generation, operation
        self.context: object | None = None
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result, error = self.operation(), None
        except Exception as exc:
            result, error = None, exc
        self.signals.finished.emit((self, result, error))


class TreatmentPage(QWidget):
    def __init__(
        self, client: TreatmentClient, organization_id: UUID, *, can_manage: bool = True
    ) -> None:
        super().__init__()
        self.client, self.organization_id, self.can_manage = client, organization_id, can_manage
        self.selected_customer_id: UUID | None = None
        self.selected_record_id: UUID | None = None
        self.customers: list[Customer] = []
        self.records: list[Treatment] = []
        self._workers: set[_Request] = set()
        self._generation = 0
        self._correcting = False
        self._conflicted = False
        self._pending_mutation: tuple[dict[str, object], str] | None = None
        self._events_dialog: TreatmentEventsDialog | None = None
        self._event_record_id: UUID | None = None
        self._consultation_dialog: ConsultationDialog | None = None
        self._documents_dialog: DocumentIssuanceDialog | None = None
        self._sales_draft_dialog: SalesDraftDialog | None = None
        self.is_loading, self.is_saving = False, False
        self._pending_customer: UUID | None = None
        self.setObjectName("treatment-workspace")
        self.setStyleSheet("""
            QWidget#treatment-workspace {background:#f8f7f4; color:#292e37;}
            QFrame#treatment-pane {background:white; border:1px solid #e7e2dc; border-radius:10px;}
            QLabel {border:0; background:transparent;}
            QLabel#treatment-title {font-size:24px; font-weight:700;}
            QLabel#section-heading {font-size:16px; font-weight:600;}
            QListWidget, QTableWidget {background:white; border:0; color:#292e37;}
            QListWidget::item {padding:14px 7px; border-bottom:1px solid #f0ece7;}
            QListWidget::item:selected {background:#ede4d9; color:#292e37;}
            QTableWidget::item:selected {background:#ede4d9; color:#292e37;}
            QHeaderView::section {background:#f3f0ec; padding:8px; border:0; color:#62594f;}
            QPushButton {min-height: 16px; padding:8px; background:#faf8f5;
                border:1px solid #ded4c8;
                border-radius:8px; color:#35312d;}
            QPushButton#treatment-save {background:#242c38; color:white; border:0;}
            QPushButton:disabled {color:#aaa; background:#f1efec;}
        """)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 22, 20, 18)
        heading = QLabel("시술관리")
        heading.setObjectName("treatment-title")
        layout.addWidget(heading)
        layout.addWidget(QLabel("고객별 시술 기록과 다음 방문 계획을 한곳에서 관리하세요."))
        self.lifecycle = TreatmentLifecycle()
        layout.addWidget(self.lifecycle)
        layout.addSpacing(12)
        columns = QHBoxLayout()
        columns.setSpacing(12)

        def pane(title: str) -> tuple[QFrame, QVBoxLayout]:
            frame = QFrame()
            frame.setObjectName("treatment-pane")
            box = QVBoxLayout(frame)
            box.setContentsMargins(14, 18, 14, 14)
            label = QLabel(title)
            label.setObjectName("section-heading")
            box.addWidget(label)
            return frame, box

        left, customer_box = pane("고객 선택")
        left.setFixedWidth(210)
        self.customer_search = QLineEdit()
        self.customer_search.setPlaceholderText("이름 · 연락처 검색")
        customer_box.addWidget(self.customer_search)
        self.customer_list = QListWidget()
        customer_box.addWidget(self.customer_list, 1)
        self.cautions = QLabel("고객을 선택하세요.")
        self.cautions.setWordWrap(True)
        self.cautions.setMinimumHeight(95)
        customer_box.addWidget(self.cautions)
        columns.addWidget(left)
        middle, history_box = pane("시술 이력")
        self.record_search = QLineEdit()
        self.record_search.setPlaceholderText("시술명 · 담당자 · 기록 검색")
        history_box.addWidget(self.record_search)
        filters = QHBoxLayout()
        self.date_from, self.date_to = QLineEdit(), QLineEdit()
        for field, placeholder in ((self.date_from, "시작일"), (self.date_to, "종료일")):
            field.setPlaceholderText(placeholder + " YYYY-MM-DD")
            field.setMinimumWidth(0)
            filters.addWidget(field)
        history_box.addLayout(filters)
        self.category_filter = QComboBox()
        self.category_filter.addItem("전체 분류")
        history_box.addWidget(self.category_filter)
        self.filter_status = QLabel("0건")
        history_box.addWidget(self.filter_status)
        self.history_table = QTableWidget(0, 4)
        self.history_table.setHorizontalHeaderLabels(["시술일", "시술명", "담당자", "상태"])
        self.history_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.history_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.history_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.history_table.verticalHeader().hide()
        self.history_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.history_table.setWordWrap(False)
        self.history_table.setAlternatingRowColors(True)
        history_box.addWidget(self.history_table, 1)
        self.retry_button = QPushButton("새로고침")
        history_box.addWidget(self.retry_button)
        columns.addWidget(middle, 1)
        right, form_box = pane("시술 기록 작성")
        right.setMinimumWidth(310)
        right.setMaximumWidth(390)
        self.editor_heading = QLabel("새 기록")
        form_box.addWidget(self.editor_heading)
        actions = QHBoxLayout()
        self.new_button, self.copy_button = QPushButton("새 기록"), QPushButton("선택 기록 복사")
        actions.addWidget(self.new_button)
        actions.addWidget(self.copy_button)
        form_box.addLayout(actions)
        self.form = TreatmentForm(can_manage)
        self.form.setMinimumHeight(365)
        form_scroll = QScrollArea()
        form_scroll.setWidgetResizable(True)
        form_scroll.setFrameShape(QFrame.Shape.NoFrame)
        form_scroll.setWidget(self.form)
        form_box.addWidget(form_scroll, 1)
        self.save_button = QPushButton("시술 기록 저장")
        self.save_button.setObjectName("treatment-save")
        form_box.addWidget(self.save_button)
        columns.addWidget(right, 1)
        layout.addLayout(columns, 1)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)
        self.customer_list.currentRowChanged.connect(self._customer_changed)
        self.customer_search.textChanged.connect(self._filter_customers)
        self.history_table.currentCellChanged.connect(self._record_changed)
        for field in (self.record_search, self.date_from, self.date_to):
            field.textChanged.connect(self._filter_records)
        self.category_filter.currentIndexChanged.connect(self._filter_records)
        self.save_button.clicked.connect(self._save)
        self.new_button.clicked.connect(self._new_record)
        self.copy_button.clicked.connect(self._copy_record)
        self.retry_button.clicked.connect(self._reload)
        self.lifecycle.start_button.clicked.connect(lambda: self._transition("start"))
        self.lifecycle.complete_button.clicked.connect(lambda: self._transition("complete"))
        self.lifecycle.cancel_button.clicked.connect(lambda: self._transition("cancel"))
        self.lifecycle.correct_button.clicked.connect(self._begin_correction)
        self.lifecycle.events_button.clicked.connect(self._show_events)
        self.lifecycle.consultation_button.clicked.connect(self._show_consultation)
        self.lifecycle.documents_button.clicked.connect(self._show_documents)
        self.lifecycle.sales_button.clicked.connect(self._show_sales_draft)
        self._load_customers()

    def _record(self) -> Treatment | None:
        return next((r for r in self.records if r.id == self.selected_record_id), None)

    def _clear_correction(self) -> None:
        self._correcting = False
        self.lifecycle.reason_input.clear()

    def _request(
        self, kind: str, operation: Callable[[], Any], context: object | None = None
    ) -> None:
        worker = _Request(kind, self._generation, operation)
        worker.context = context
        self._workers.add(worker)
        worker.signals.finished.connect(self._finished)
        QThreadPool.globalInstance().start(worker)

    def _controls(self) -> None:
        writable = self.can_manage and self.selected_customer_id is not None
        ready = writable and not self.is_loading and not self.is_saving
        record = self._record()
        locked = record is not None and record.status in {"completed", "cancelled"}
        self.save_button.setEnabled(
            ready and not self._conflicted and (not locked or self._correcting)
        )
        self.save_button.setText("정정 내용 저장" if self._correcting else "시술 기록 저장")
        readonly = not self.can_manage or (locked and not self._correcting)
        for field in self.form._fields.values():
            field.setReadOnly(readonly)
        self.form.notes_input.setReadOnly(readonly)
        self.lifecycle.update_state(
            record,
            self.can_manage,
            self.is_loading or self.is_saving or self._conflicted,
            self._correcting,
        )
        self.new_button.setEnabled(ready)
        self.copy_button.setEnabled(ready and self.selected_record_id is not None)
        self.form.setEnabled(
            self.selected_customer_id is not None and not self.is_saving and not self.is_loading
        )
        self.retry_button.setEnabled(not self.is_saving and not self.is_loading)

    def _load_customers(self) -> None:
        self.is_loading = True
        self.status_label.setText("고객 목록을 불러오는 중…")
        self._controls()
        self._request("customers", lambda: self.client.list_customers(self.organization_id))

    @Slot(object)
    def _finished(self, outcome: Any) -> None:
        worker, result, error = outcome
        self._workers.discard(worker)
        if worker.generation != self._generation:
            return
        if worker.kind == "consultation-open":
            self.is_loading = False
            if error is not None:
                self.status_label.setText(
                    "최신 고객·상담 정보를 불러오지 못했습니다. 다시 열어주세요."
                )
            else:
                customer, record = result
                if self.selected_record_id == record.id:
                    self.customers = [
                        customer if c.id == customer.id else c for c in self.customers
                    ]
                    self._consultation_saved(record)
                    dialog = ConsultationDialog(
                        customer,
                        record,
                        lambda values: self.client.mutate_treatment(
                            self.organization_id, customer.id, record.id, values
                        ),
                        can_manage=self.can_manage,
                        parent=self,
                    )
                    self._consultation_dialog = dialog
                    dialog.setStyleSheet(self.styleSheet())
                    dialog.saved.connect(self._consultation_saved)
                    dialog.show()
            self._controls()
            return
        if worker.kind == "events":
            if self._events_dialog is not None and worker.context is self._events_dialog:
                if error is not None:
                    self._events_dialog.text.setPlainText(
                        "변경 이력을 불러오지 못했습니다. 닫고 다시 열어주세요."
                    )
                elif result[0] == self._event_record_id:
                    self._events_dialog.display(result[1])
            return
        if worker.kind == "save":
            self.is_saving = False
        else:
            self.is_loading = False
        if error is not None:
            self.status_label.setText(
                "저장 실패 · 입력은 유지됩니다. 이력을 확인한 뒤 재시도하세요."
                if worker.kind == "save"
                else "조회 실패 · 새로고침으로 재시도하세요."
            )
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 409:
                self._conflicted = True
                self.status_label.setText(
                    "다른 변경 또는 상태 충돌이 있습니다. "
                    "입력은 유지됩니다. 새로고침 후 비교하세요."
                )
        elif worker.kind == "customers":
            self.customers = result
            self.customer_list.blockSignals(True)
            self.customer_list.clear()
            for customer in self.customers:
                item = QListWidgetItem(f"{customer.name}\n{customer.phone or '연락처 미등록'}")
                item.setData(Qt.ItemDataRole.UserRole, customer.id)
                self.customer_list.addItem(item)
            self.customer_list.blockSignals(False)
            self.status_label.setText("고객관리에서 고객을 먼저 등록하세요." if not result else "")
            if result:
                self.open_customer(
                    next((c.id for c in result if c.id == self._pending_customer), result[0].id)
                )
                self._pending_customer = None
        elif worker.kind == "history":
            self._conflicted = False
            self._pending_mutation = None
            self.records = result
            self._clear_correction()
            if self.selected_record_id is not None:
                record = self._record()
                if record is None:
                    self.selected_record_id = None
                self.form.populate(record)
            self._render_records()
            self.status_label.setText(
                "시술 이력을 불러왔습니다." if result else "아직 시술 기록이 없습니다."
            )
        else:
            self._clear_correction()
            self._pending_mutation = None
            self._conflicted = False
            self.records = [r for r in self.records if r.id != result.id] + [result]
            self.selected_record_id = result.id
            self.form.populate(result)
            self.editor_heading.setText("기록 수정")
            self._render_records()
            self.status_label.setText("시술 기록을 저장했습니다.")
        self._controls()

    def open_customer(self, customer_id: UUID) -> bool:
        if not self.customers and self.is_loading:
            self._pending_customer = customer_id
            return True
        if customer_id == self.selected_customer_id:
            return True
        customer = next((c for c in self.customers if c.id == customer_id), None)
        if not self.confirm_leave():
            return False
        if customer is None:
            self._pending_customer = customer_id
            self._generation += 1
            self._load_customers()
            return True
        self.selected_customer_id = customer_id
        self._clear_correction()
        self._conflicted = False
        self._pending_mutation = None
        self.selected_record_id = None
        self._generation += 1
        self.records = []
        self._render_records()
        self.form.populate(None)
        self.editor_heading.setText(f"{customer.name} · 새 기록")
        self.cautions.setText(
            f"피부 타입 · {customer.skin_type or '미등록'}\n\n"
            f"알레르기 · 주의사항\n{customer.allergies or '미등록 · 상담 시 확인'}"
        )
        self.customer_list.blockSignals(True)
        self.customer_list.setCurrentRow(self.customers.index(customer))
        self.customer_list.blockSignals(False)
        self._load_history()
        return True

    def _customer_changed(self, row: int) -> None:
        if row >= 0 and not self.open_customer(self.customers[row].id):
            previous = next(
                (i for i, c in enumerate(self.customers) if c.id == self.selected_customer_id), -1
            )
            self.customer_list.blockSignals(True)
            self.customer_list.setCurrentRow(previous)
            self.customer_list.blockSignals(False)

    def _load_history(self) -> None:
        customer_id = self.selected_customer_id
        if customer_id is None:
            return
        self.is_loading = True
        self.status_label.setText("시술 이력을 불러오는 중…")
        self._controls()
        self._request(
            "history", lambda: self.client.list_treatments(self.organization_id, customer_id)
        )

    def _reload(self) -> None:
        if not self.confirm_leave():
            return
        if self.selected_customer_id:
            self._generation += 1
            self._load_history()
        else:
            self._load_customers()

    def has_unsaved_changes(self) -> bool:
        return self.can_manage and (self.form.dirty() or self._correcting)

    def confirm_leave(self) -> bool:
        if (
            self._sales_draft_dialog is not None
            and self._sales_draft_dialog.isVisible()
            and not self._sales_draft_dialog.confirm_leave()
        ):
            return False
        if (
            self._documents_dialog is not None
            and self._documents_dialog.isVisible()
            and not self._documents_dialog.confirm_leave()
        ):
            return False
        if (
            self._consultation_dialog is not None
            and self._consultation_dialog.isVisible()
            and not self._consultation_dialog._can_close()
        ):
            return False
        if self.is_saving:
            self.status_label.setText("저장이 끝난 뒤 이동하세요.")
            return False
        if not self.has_unsaved_changes():
            return True
        choice = QMessageBox.question(
            self,
            "작성 중인 시술 기록",
            "변경 내용을 저장할까요?",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if choice == QMessageBox.StandardButton.Save:
            self._save()
            return False
        if choice == QMessageBox.StandardButton.Discard:
            self._clear_correction()
            record = next((r for r in self.records if r.id == self.selected_record_id), None)
            self.form.populate(record)
            self._controls()
            return True
        return False

    def _new_record(self) -> None:
        if self.can_manage and self.confirm_leave():
            self._clear_correction()
            self._conflicted = False
            self.selected_record_id = None
            self.form.populate(None)
            self._render_records()
            self.editor_heading.setText("새 기록")
            self._controls()

    def _copy_record(self) -> None:
        record = next((r for r in self.records if r.id == self.selected_record_id), None)
        if record is None or not self.can_manage or not self.confirm_leave():
            return
        self._clear_correction()
        self._conflicted = False
        self.selected_record_id = None
        self.form.populate(None)
        baseline = self.form._baseline
        self.form.populate(record)
        self.form.date_input.setText(date.today().isoformat())
        self.form.next_date_input.clear()
        self.form._baseline = baseline
        self._render_records()
        self.editor_heading.setText("복사한 새 기록 · 저장 전")
        self._controls()

    def _save(self) -> None:
        if (
            not self.can_manage
            or self.is_saving
            or self.is_loading
            or self._conflicted
            or not self.selected_customer_id
        ):
            return
        try:
            values = self.form.values()
        except ValueError as exc:
            self.status_label.setText(str(exc))
            return
        record = self._record()
        if record is not None:
            if record.status in {"completed", "cancelled"} and not self._correcting:
                self.status_label.setText("완료·중단 기록은 정정 버튼으로 변경하세요.")
                return
            reason = self.lifecycle.reason_input.text().strip() if self._correcting else ""
            if self._correcting and not reason:
                self.status_label.setText("정정 사유를 입력하세요.")
                return
            self._mutate("correct" if self._correcting else "edit", values, reason)
            return
        customer_id = self.selected_customer_id
        self.is_saving = True
        self.status_label.setText("저장 중…")
        self._controls()
        self._request(
            "save", lambda: self.client.create_treatment(self.organization_id, customer_id, values)
        )

    def _begin_correction(self) -> None:
        record = self._record()
        if (
            not self.can_manage
            or self.is_saving
            or self.is_loading
            or self._conflicted
            or record is None
            or record.status not in {"completed", "cancelled", "legacy"}
        ):
            return
        self._correcting = True
        self.editor_heading.setText("기록 정정 · 원본 이력 보존")
        self.status_label.setText(
            "정정할 내용과 사유를 입력하세요. 이전 내용은 변경 이력에 보존됩니다."
        )
        self._controls()
        self.lifecycle.reason_input.setFocus()

    def _transition(self, action: str) -> None:
        record = self._record()
        if (
            not self.can_manage
            or self.is_saving
            or self.is_loading
            or self._conflicted
            or record is None
        ):
            return
        if self.has_unsaved_changes():
            self.status_label.setText("작성 중인 내용을 먼저 저장한 뒤 상태를 변경하세요.")
            return
        allowed = {
            "start": {"draft"},
            "complete": {"in_progress"},
            "cancel": {"draft", "in_progress"},
        }
        if record.status not in allowed.get(action, set()):
            return
        if action == "start":
            customer = next((c for c in self.customers if c.id == record.customer_id), None)
            if customer is None or not consultation_ready(record, customer):
                self.status_label.setText(
                    "상담 기록에서 목표를 입력하고 고객 주의사항을 확인·저장하세요."
                )
                return
        reason = ""
        if action == "cancel":
            if self._pending_mutation is not None:
                pending = self._pending_mutation[0]
                if (
                    pending.get("record_id") == str(record.id)
                    and pending.get("action") == "cancel"
                    and pending.get("expected_version") == record.version
                ):
                    reason = str(pending.get("reason", ""))
            reason, accepted = QInputDialog.getText(
                self, "시술 중단", "중단 사유 (필수)", text=reason
            )
            if not accepted:
                return
            reason = reason.strip()
            if not reason or len(reason) > 2000:
                self.status_label.setText("중단 사유는 1~2,000자로 입력하세요.")
                return
        self._mutate(action, None, reason)

    def _mutate(self, action: str, values: dict[str, object] | None, reason: str) -> None:
        record, customer_id = self._record(), self.selected_customer_id
        if record is None or customer_id is None:
            return
        payload: dict[str, object] = {
            "action": action,
            "values": values,
            "reason": reason,
            "expected_version": record.version,
        }
        fingerprint = {**payload, "record_id": str(record.id), "customer_id": str(customer_id)}
        if self._pending_mutation is None or self._pending_mutation[0] != fingerprint:
            self._pending_mutation = (fingerprint, str(uuid4()))
        payload["operation_id"] = self._pending_mutation[1]
        self.is_saving = True
        self.status_label.setText("변경 사항을 저장하는 중…")
        self._controls()
        self._request(
            "save",
            lambda: self.client.mutate_treatment(
                self.organization_id, customer_id, record.id, payload
            ),
        )

    def _show_events(self) -> None:
        record, customer_id = self._record(), self.selected_customer_id
        if record is None or customer_id is None or self.is_saving:
            return
        if self._events_dialog is not None:
            self._events_dialog.close()
        self._event_record_id = record.id
        self._events_dialog = TreatmentEventsDialog(self)
        self._events_dialog.setModal(True)
        self._events_dialog.show()
        self._request(
            "events",
            lambda: (
                record.id,
                self.client.list_treatment_events(self.organization_id, customer_id, record.id),
            ),
            context=self._events_dialog,
        )

    def _show_consultation(self) -> None:
        record, customer_id = self._record(), self.selected_customer_id
        if record is None or customer_id is None or self.is_saving or self.is_loading:
            return
        if self.has_unsaved_changes():
            self.status_label.setText("작성 중인 시술 내용을 먼저 저장한 뒤 상담을 열어주세요.")
            return
        if self._consultation_dialog is not None and self._consultation_dialog.isVisible():
            self._consultation_dialog.raise_()
            return
        self.is_loading = True
        self.status_label.setText("최신 고객 주의사항과 상담을 불러오는 중…")
        self._controls()

        def load() -> tuple[Customer, Treatment]:
            customers = self.client.list_customers(self.organization_id)
            records = self.client.list_treatments(self.organization_id, customer_id)
            return (
                next(c for c in customers if c.id == customer_id),
                next(r for r in records if r.id == record.id),
            )

        self._request("consultation-open", load)

    def _show_sales_draft(self) -> None:
        record = self._record()
        if (
            record is None
            or record.status not in {"completed", "cancelled"}
            or self.is_saving
            or self.is_loading
        ):
            return
        if self.has_unsaved_changes():
            self.status_label.setText(
                "작성 중인 시술 내용을 먼저 저장한 뒤 결제 초안을 열어주세요."
            )
            return
        if self._sales_draft_dialog is not None and self._sales_draft_dialog.isVisible():
            self._sales_draft_dialog.raise_()
            return
        self._sales_draft_dialog = SalesDraftDialog(
            self.client,
            self.organization_id,
            record,
            can_manage=self.can_manage,
            parent=self,
        )
        self._sales_draft_dialog.show()

    def _show_documents(self) -> None:
        record, customer_id = self._record(), self.selected_customer_id
        if record is None or customer_id is None or self.is_saving or self.is_loading:
            return
        if self.has_unsaved_changes():
            self.status_label.setText("작성 중인 시술 내용을 먼저 저장한 뒤 문서를 열어주세요.")
            return
        if self._documents_dialog is not None and self._documents_dialog.isVisible():
            self._documents_dialog.raise_()
            return
        self._documents_dialog = DocumentIssuanceDialog(
            self.client,
            self.organization_id,
            customer_id,
            record.id,
            can_manage=self.can_manage,
            parent=self,
        )
        self._documents_dialog.show()

    def _consultation_saved(self, record: Treatment) -> None:
        if record.customer_id != self.selected_customer_id:
            return
        self.records = [record if r.id == record.id else r for r in self.records]
        if self.selected_record_id == record.id:
            self.form.populate(record)
        self._conflicted = False
        self._pending_mutation = None
        self._render_records()
        self._controls()
        self.status_label.setText("상담 기록과 시술 버전을 반영했습니다.")

    def _render_records(self) -> None:
        self.records.sort(key=lambda r: (r.treatment_date, str(r.id)), reverse=True)
        self.history_table.blockSignals(True)
        self.history_table.setRowCount(len(self.records))
        for row, record in enumerate(self.records):
            for col, value in enumerate(
                (
                    record.treatment_date,
                    record.treatment_name,
                    record.practitioner,
                    STATUS_LABELS[record.status],
                )
            ):
                item = QTableWidgetItem(value)
                item.setToolTip(record.notes or value)
                self.history_table.setItem(row, col, item)
            self.history_table.setRowHeight(row, 48)
        selected = next(
            (i for i, r in enumerate(self.records) if r.id == self.selected_record_id), -1
        )
        self.history_table.setCurrentCell(selected, 0)
        self.history_table.blockSignals(False)
        previous = self.category_filter.currentText()
        self.category_filter.blockSignals(True)
        self.category_filter.clear()
        self.category_filter.addItems(
            ["전체 분류"] + sorted({r.category for r in self.records if r.category})
        )
        self.category_filter.setCurrentText(previous)
        self.category_filter.blockSignals(False)
        self._filter_records()

    def _record_changed(self, row: int, *_: Any) -> None:
        if row < 0 or row >= len(self.records):
            return
        record = self.records[row]
        if record.id == self.selected_record_id:
            return
        if not self.confirm_leave():
            self.history_table.blockSignals(True)
            previous = next(
                (i for i, r in enumerate(self.records) if r.id == self.selected_record_id), -1
            )
            self.history_table.setCurrentCell(previous, 0)
            self.history_table.blockSignals(False)
            return
        self._clear_correction()
        self._conflicted = False
        self._pending_mutation = None
        self.selected_record_id = record.id
        self.form.populate(record)
        self.editor_heading.setText("기록 수정" if self.can_manage else "기록 조회 · 읽기 전용")
        self._controls()

    def _filter_customers(self) -> None:
        query = self.customer_search.text().strip().casefold().replace("-", "")
        for row, customer in enumerate(self.customers):
            content = (customer.name + (customer.phone or "")).casefold().replace("-", "")
            self.customer_list.item(row).setHidden(query not in content)

    def _filter_records(self) -> None:
        start, end = self.date_from.text().strip(), self.date_to.text().strip()
        try:
            for value in (start, end):
                if value:
                    valid_date(value)
            if start and end and start > end:
                raise ValueError("날짜 범위의 시작일이 종료일보다 늦습니다.")
        except ValueError as exc:
            self.filter_status.setText(str(exc))
            return
        query, category = (
            self.record_search.text().strip().casefold(),
            self.category_filter.currentText(),
        )
        count = 0
        for row, record in enumerate(self.records):
            visible = (
                query in f"{record.treatment_name} {record.practitioner} {record.notes}".casefold()
                and (not start or record.treatment_date >= start)
                and (not end or record.treatment_date <= end)
                and (category == "전체 분류" or category == record.category)
            )
            self.history_table.setRowHidden(row, not visible)
            count += visible
        self.filter_status.setText(f"전체 {len(self.records)}건 중 {count}건")
