"""Treatment state controls and immutable change history presentation."""

from datetime import datetime

from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from business_assistant_desktop.api_client import Treatment

STATUS_LABELS = {
    "legacy": "기존 기록",
    "draft": "준비",
    "in_progress": "진행 중",
    "completed": "완료",
    "cancelled": "중단",
}
ACTION_LABELS = {
    "consult": "상담 기록·주의 확인",
    "edit": "기록 수정",
    "correct": "기록 정정",
    "start": "시술 시작",
    "complete": "시술 완료",
    "cancel": "시술 중단",
}
FIELD_LABELS = {
    "consultation_goal": "상담 목표",
    "consultation_plan": "예정 관리 내용",
    "cautions_snapshot": "확인한 고객 주의정보",
    "cautions_acknowledged_by": "주의 확인자",
    "cautions_acknowledged_at": "주의 확인 시각",
    "treatment_name": "시술명",
    "treatment_date": "시술일",
    "category": "분류",
    "practitioner": "담당자",
    "notes": "시술 내용",
    "amount": "예정 금액",
    "next_visit_date": "다음 방문일",
    "status": "상태",
    "version": "버전",
    "started_at": "시작 시각",
    "ended_at": "종료 시각",
}


def local_time(value: object) -> str:
    try:
        return (
            datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            .astimezone()
            .strftime("%Y-%m-%d %H:%M")
        )
    except ValueError:
        return str(value or "—")


class TreatmentLifecycle(QWidget):
    def __init__(self) -> None:
        super().__init__()
        box = QVBoxLayout(self)
        box.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        self.state_label = QLabel("새 기록 · 저장 후 시술을 시작할 수 있습니다.")
        self.state_label.setWordWrap(True)
        self.state_label.setMinimumWidth(0)
        row.addWidget(self.state_label, 1)
        self.start_button = QPushButton("시작")
        self.complete_button = QPushButton("완료")
        self.cancel_button = QPushButton("중단")
        self.correct_button = QPushButton("정정")
        self.events_button = QPushButton("변경 이력")
        self.consultation_button = QPushButton("상담 기록")
        self.documents_button = QPushButton("문서 발행·이력")
        self.sales_button = QPushButton("결제 초안")
        for button in (
            self.consultation_button,
            self.documents_button,
            self.sales_button,
            self.start_button,
            self.complete_button,
            self.cancel_button,
            self.correct_button,
            self.events_button,
        ):
            button.setFixedHeight(34)
            row.addWidget(button)
        box.addLayout(row)
        self.reason_input = QLineEdit()
        self.reason_input.setPlaceholderText("정정 사유를 입력하세요 (필수)")
        self.reason_input.setMaxLength(2000)
        self.reason_input.hide()
        box.addWidget(self.reason_input)

    def update_state(
        self, record: Treatment | None, writable: bool, busy: bool, correcting: bool
    ) -> None:
        status = record.status if record else "new"
        text = (
            f"{STATUS_LABELS.get(status, status)} · 버전 {record.version}"
            if record
            else "새 기록 · 저장 후 시술을 시작할 수 있습니다."
        )
        if record and record.started_at:
            text += f"  |  시작 {local_time(record.started_at)}"
        if record and record.ended_at:
            text += f"  |  종료 {local_time(record.ended_at)}"
        self.state_label.setText(text)
        ready = writable and not busy and not correcting
        self.start_button.setEnabled(ready and status == "draft")
        self.complete_button.setEnabled(ready and status == "in_progress")
        self.cancel_button.setEnabled(ready and status in {"draft", "in_progress"})
        self.correct_button.setEnabled(ready and status in {"completed", "cancelled", "legacy"})
        self.events_button.setEnabled(record is not None and not busy)
        self.consultation_button.setEnabled(record is not None and not busy)
        self.documents_button.setEnabled(record is not None and not busy)
        self.sales_button.setEnabled(
            status in {"completed", "cancelled"} and not busy and not correcting
        )
        self.reason_input.setVisible(correcting)
        self.reason_input.setEnabled(not busy)


class TreatmentEventsDialog(QDialog):
    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setWindowTitle("시술 변경 이력")
        self.resize(650, 500)
        box = QVBoxLayout(self)
        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        self.text.setPlainText("변경 이력을 불러오는 중…")
        box.addWidget(self.text)
        close = QPushButton("닫기")
        close.clicked.connect(self.close)
        box.addWidget(close)

    def display(self, events: list[dict[str, object]]) -> None:
        parts = []
        for event in events:
            parts.append(
                f"{local_time(event.get('occurred_at'))}  ·  "
                f"{ACTION_LABELS.get(str(event.get('action')), str(event.get('action')))}"
            )
            parts.append(f"기록자 ID: {event.get('actor_id', '—')}")
            if event.get("reason"):
                parts.append(f"사유: {event['reason']}")
            before, after = event.get("before_data"), event.get("after_data")
            if isinstance(before, dict) and isinstance(after, dict):
                for field, label in FIELD_LABELS.items():
                    if before.get(field) != after.get(field):
                        old_value = before.get(field)
                        new_value = after.get(field)
                        parts.append(
                            f"{label}: {'—' if old_value is None else old_value} → "
                            f"{'—' if new_value is None else new_value}"
                        )
            parts.append("─" * 45)
        self.text.setPlainText(
            "\n".join(parts)
            if parts
            else "저장된 변경 이력이 없습니다.\n기존 기록의 과거 변경은 소급 생성하지 않습니다."
        )
