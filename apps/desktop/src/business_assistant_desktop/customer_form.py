"""Customer profile fields and validation, shared by create/edit flows."""

from datetime import date

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QComboBox, QGridLayout, QLineEdit, QTextEdit, QVBoxLayout, QWidget

from business_assistant_desktop.api_client import Customer
from business_assistant_desktop.customer_widgets import label


class CustomerForm(QWidget):
    changed = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setObjectName("info-panel")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(6)
        heading = label("고객 정보", "section-title")
        layout.addWidget(heading)
        self.fields: dict[str, QLineEdit] = {}
        for key in (
            "name",
            "phone",
            "birth_date",
            "skin_type",
            "tags",
            "allergies",
            "last_visit_date",
            "next_visit_date",
            "email",
            "concerns",
        ):
            field = QLineEdit()
            field.textChanged.connect(lambda *_: self.changed.emit())
            self.fields[key] = field
        for key in ("birth_date", "last_visit_date", "next_visit_date"):
            self.fields[key].setPlaceholderText("YYYY-MM-DD")
            self.fields[key].setMaxLength(10)
        self.fields["name"].setMaxLength(200)
        self.fields["email"].setMaxLength(320)
        self.fields["phone"].setMaxLength(50)
        for key in ("tags", "concerns"):
            self.fields[key].setPlaceholderText("쉼표로 구분")
        self.status = QComboBox()
        self.status.addItem("활성", "active")
        self.status.addItem("보관", "archived")
        self.status.currentIndexChanged.connect(lambda *_: self.changed.emit())
        self.notes = QTextEdit()
        self.notes.setFixedHeight(42)
        self.notes.setPlaceholderText("상담 내용과 응대 시 참고 사항")
        self.notes.textChanged.connect(lambda *_: self.changed.emit())
        grid = QGridLayout()
        grid.setSpacing(6)
        rows = (
            ("이름 *", self.fields["name"], "알레르기 · 주의사항", self.fields["allergies"]),
            ("연락처", self.fields["phone"], "최근 방문일", self.fields["last_visit_date"]),
            (
                "생년월일",
                self.fields["birth_date"],
                "다음 방문 예정",
                self.fields["next_visit_date"],
            ),
            ("피부 타입", self.fields["skin_type"], "이메일", self.fields["email"]),
            ("고객 태그", self.fields["tags"], "고객 상태", self.status),
        )
        for row, (first, field, second, other) in enumerate(rows):
            grid.addWidget(label(first), row, 0)
            grid.addWidget(field, row, 1)
            grid.addWidget(label(second), row, 2)
            grid.addWidget(other, row, 3)
            field.setAccessibleName(first)
            other.setAccessibleName(second)
        grid.addWidget(label("주요 고민"), 5, 0)
        grid.addWidget(self.fields["concerns"], 5, 1, 1, 3)
        self.fields["concerns"].setAccessibleName("주요 고민")
        grid.addWidget(label("상담 메모"), 6, 0)
        grid.addWidget(self.notes, 6, 1, 1, 3)
        self.notes.setAccessibleName("상담 메모")
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        layout.addLayout(grid)
        self._baseline = self.raw_values()

    def raw_values(self) -> dict[str, object]:
        return {
            **{key: widget.text() for key, widget in self.fields.items()},
            "status": self.status.currentData(),
            "notes": self.notes.toPlainText(),
        }

    def is_dirty(self) -> bool:
        return self.raw_values() != self._baseline

    def mark_clean(self) -> None:
        self._baseline = self.raw_values()
        self.changed.emit()

    def populate(self, customer: Customer | None) -> None:
        for key, field in self.fields.items():
            value = getattr(customer, key, "") if customer else ""
            field.setText(", ".join(value) if isinstance(value, tuple) else str(value or ""))
        self.status.setCurrentIndex(self.status.findData(customer.status if customer else "active"))
        self.notes.setPlainText(customer.notes if customer else "")
        self.mark_clean()

    def set_readonly(self, readonly: bool) -> None:
        for field in self.fields.values():
            field.setReadOnly(readonly)
        self.notes.setReadOnly(readonly)
        self.status.setEnabled(not readonly)

    def values(self) -> dict[str, object]:
        values: dict[str, object] = {
            key: widget.text().strip() or None for key, widget in self.fields.items()
        }
        for key in ("tags", "concerns"):
            values[key] = list(
                dict.fromkeys(
                    part.strip() for part in self.fields[key].text().split(",") if part.strip()
                )
            )
        values["allergies"] = self.fields["allergies"].text().strip()
        values["notes"] = self.notes.toPlainText().strip()
        values["status"] = self.status.currentData()
        name = str(values["name"] or "")
        if not name:
            raise ValueError("고객 이름을 입력해 주세요.")
        email = str(values["email"] or "")
        if email and (
            email.count("@") != 1 or any(c.isspace() for c in email) or not all(email.split("@"))
        ):
            raise ValueError("이메일 주소를 확인해 주세요.")
        if len(str(values["notes"])) > 5000:
            raise ValueError("상담 메모는 5,000자 이내로 입력해 주세요.")
        for key in ("birth_date", "last_visit_date", "next_visit_date"):
            value = str(values[key] or "")
            if value:
                try:
                    parsed = date.fromisoformat(value)
                    if parsed.isoformat() != value:
                        raise ValueError
                except ValueError:
                    raise ValueError(
                        "날짜는 YYYY-MM-DD 형식의 유효한 날짜를 입력해 주세요."
                    ) from None
        if values["birth_date"] and str(values["birth_date"]) > date.today().isoformat():
            raise ValueError("생년월일은 오늘 이후 날짜일 수 없습니다.")
        return values
