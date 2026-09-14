from business_assistant_common.entitlements import EntitlementSet


def test_entitlement_set_checks_exact_feature_code() -> None:
    entitlements = EntitlementSet(frozenset({"dashboard.basic", "crm.basic"}))
    assert entitlements.has("crm.basic") is True
    assert entitlements.has("crm.export") is False
