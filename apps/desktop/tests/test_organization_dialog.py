from uuid import UUID

from business_assistant_desktop.api_client import Organization
from business_assistant_desktop.organization_dialog import OrganizationDialog
from PySide6.QtCore import Qt


def test_organization_dialog_validates_slug_and_creates_organization(qtbot) -> None:  # type: ignore[no-untyped-def]
    created: list[Organization] = []
    organization = Organization(
        UUID("11111111-1111-1111-1111-111111111111"), "테스트", "test", "owner"
    )
    dialog = OrganizationDialog(lambda name, slug: organization, created.append)
    qtbot.addWidget(dialog)
    dialog.name_input.setText("테스트 조직")
    dialog.slug_input.setText("test-org")
    qtbot.mouseClick(dialog.submit_button, Qt.MouseButton.LeftButton)
    assert created == [organization]
    assert dialog.result() == dialog.DialogCode.Accepted


def test_organization_dialog_rejects_invalid_slug(qtbot) -> None:  # type: ignore[no-untyped-def]
    dialog = OrganizationDialog(lambda name, slug: None, lambda _: None)  # type: ignore[return-value]
    qtbot.addWidget(dialog)
    dialog.name_input.setText("테스트 조직")
    dialog.slug_input.setText("잘못된 코드")
    qtbot.mouseClick(dialog.submit_button, Qt.MouseButton.LeftButton)
    assert "조직 코드" in dialog.error_label.text()
