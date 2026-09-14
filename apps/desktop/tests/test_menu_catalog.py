from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.menu_catalog import visible_menus


def test_visible_menus_include_free_and_entitled_features() -> None:
    entitlements = EntitlementSet(frozenset({"crm.basic"}))

    menu_keys = [menu.key for menu in visible_menus(entitlements)]

    assert menu_keys == ["dashboard", "crm", "account", "settings"]
