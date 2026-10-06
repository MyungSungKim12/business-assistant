"""Validated treatment record editor."""

from datetime import date
from decimal import Decimal, InvalidOperation

from PySide6.QtWidgets import QFormLayout, QLabel, QLineEdit, QTextEdit, QVBoxLayout, QWidget

from business_assistant_desktop.api_client import Treatment


def valid_date(value: str) -> str:
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError
    except ValueError as exc:
        raise ValueError("날짜는 YYYY-MM-DD 형식으로 입력하세요.") from exc
    return value


class TreatmentForm(QWidget):
    def __init__(self, can_manage: bool) -> None:
        super().__init__()
        self.setObjectName("treatment-form")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        fields = QFormLayout()
        self.date_input = QLineEdit()
        self.name_input = QLineEdit()
        self.category_input = QLineEdit()
        self.practitioner_input = QLineEdit()
        self.amount_input = QLineEdit()
        self.next_date_input = QLineEdit()
        self._fields = {
            "treatment_date": self.date_input,
            "treatment_name": self.name_input,
            "category": self.category_input,
            "practitioner": self.practitioner_input,
            "amount": self.amount_input,
            "next_visit_date": self.next_date_input,
        }
        for title, field in zip(
            ("시술일 *", "시술명 *", "분류", "담당자", "예정 금액", "다음 방문일"),
            self._fields.values(),
            strict=True,
        ):
            field.setReadOnly(not can_manage)
            field.setMinimumHeight(34)
            field.setAccessibleName(title)
            fields.addRow(title, field)
        self.name_input.setMaxLength(200)
        self.category_input.setMaxLength(100)
        self.practitioner_input.setMaxLength(100)
        self.date_input.setPlaceholderText("YYYY-MM-DD")
        self.next_date_input.setPlaceholderText("선택 · YYYY-MM-DD")
        self.amount_input.setPlaceholderText("미입력 가능 · 원")
        layout.addLayout(fields)
        layout.addWidget(QLabel("시술 내용 · 반응 · 다음 관리 계획"))
        self.notes_input = QTextEdit()
        self.notes_input.setReadOnly(not can_manage)
        self.notes_input.setPlaceholderText("사용 제품, 시술 부위와 고객 반응 등을 기록하세요.")
        layout.addWidget(self.notes_input, 1)
        hint = QLabel("예정 금액은 결제·매출에 반영되지 않습니다.")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        self.populate(None)

    def raw(self) -> dict[str, str]:
        return {
            **{k: v.text() for k, v in self._fields.items()},
            "notes": self.notes_input.toPlainText(),
        }

    def mark_clean(self) -> None:
        self._baseline = self.raw()

    def dirty(self) -> bool:
        return self.raw() != self._baseline

    def populate(self, record: Treatment | None) -> None:
        for key, field in self._fields.items():
            value = getattr(record, key) if record else None
            field.setText(str(value) if value is not None else "")
        if record is None:
            self.date_input.setText(date.today().isoformat())
        self.notes_input.setPlainText(record.notes if record else "")
        self.mark_clean()

    def values(self) -> dict[str, object]:
        raw = {k: v.strip() for k, v in self.raw().items()}
        if not raw["treatment_name"]:
            raise ValueError("시술명을 입력하세요.")
        valid_date(raw["treatment_date"])
        if raw["next_visit_date"]:
            valid_date(raw["next_visit_date"])
            if raw["next_visit_date"] < raw["treatment_date"]:
                raise ValueError("다음 방문일은 시술일 이후여야 합니다.")
        if len(raw["notes"]) > 10000:
            raise ValueError("시술 내용은 10,000자 이내로 입력하세요.")
        amount = None
        if raw["amount"]:
            try:
                amount = Decimal(raw["amount"])
                if (
                    not amount.is_finite()
                    or amount < 0
                    or amount >= Decimal("1000000000000")
                    or amount != amount.quantize(Decimal("0.01"))
                ):
                    raise ValueError
            except (ValueError, InvalidOperation) as exc:
                raise ValueError("금액은 0 이상, 1조 미만의 소수 두 자리까지 입력하세요.") from exc
        return {
            **raw,
            "amount": str(amount) if amount is not None else None,
            "next_visit_date": raw["next_visit_date"] or None,
        }
