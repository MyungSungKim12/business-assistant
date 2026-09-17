"""Organization creation dialog shown after first login."""

import re
from collections.abc import Callable

from PySide6.QtWidgets import QDialog, QFormLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout

from business_assistant_desktop.api_client import Organization


class OrganizationDialog(QDialog):
    def __init__(
        self, create: Callable[[str, str], Organization], on_created: Callable[[Organization], None]
    ) -> None:
        super().__init__()
        self.setWindowTitle("조직 만들기")
        self._create = create
        self._on_created = on_created
        self.name_input = QLineEdit()
        self.slug_input = QLineEdit()
        self.submit_button = QPushButton("조직 만들기")
        self.error_label = QLabel()
        self.error_label.setWordWrap(True)
        form = QFormLayout()
        form.addRow("조직명", self.name_input)
        form.addRow("조직 코드", self.slug_input)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(self.submit_button)
        layout.addWidget(self.error_label)
        self.submit_button.clicked.connect(self._submit)

    def _submit(self) -> None:
        name = self.name_input.text().strip()
        slug = self.slug_input.text().strip().lower()
        if not name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            self.error_label.setText(
                "조직명과 영문 소문자·숫자·하이픈 형식의 조직 코드를 입력하세요."
            )
            return
        try:
            organization = self._create(name, slug)
        except Exception:
            self.error_label.setText("조직 생성에 실패했습니다. 입력값을 확인해 주세요.")
            return
        self._on_created(organization)
        self.accept()
