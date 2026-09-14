"""Feature-gated definitions for the desktop navigation menu."""

from dataclasses import dataclass

from business_assistant_common.entitlements import EntitlementSet


@dataclass(frozen=True, slots=True)
class MenuDefinition:
    """One menu group and the feature code that grants access to it."""

    key: str
    label: str
    feature_code: str | None


MENU_CATALOG: tuple[MenuDefinition, ...] = (
    MenuDefinition("dashboard", "홈 대시보드", None),
    MenuDefinition("crm", "고객·거래처", "crm.basic"),
    MenuDefinition("schedule", "일정·할 일", "schedule.basic"),
    MenuDefinition("documents", "문서 자동화", "document.template"),
    MenuDefinition("finance", "매출·지출", "finance.basic"),
    MenuDefinition("files", "파일·자료", "files.basic"),
    MenuDefinition("data", "데이터 가져오기·내보내기", "data.basic"),
    MenuDefinition("reports", "보고서·분석", "reports.basic"),
    MenuDefinition("automation", "업무 자동화", "automation.custom"),
    MenuDefinition("ai", "AI 업무 도우미", "ai.summary"),
    MenuDefinition("notifications", "알림센터", "notifications.basic"),
    MenuDefinition("team", "팀·직원", "team.basic"),
    MenuDefinition("integrations", "외부 서비스 연동", "integrations.basic"),
    MenuDefinition("account", "계정·구독", None),
    MenuDefinition("settings", "환경설정", None),
)


def visible_menus(entitlements: EntitlementSet) -> tuple[MenuDefinition, ...]:
    """Return the catalog entries available to the current user."""
    return tuple(
        menu
        for menu in MENU_CATALOG
        if menu.feature_code is None or entitlements.has(menu.feature_code)
    )
