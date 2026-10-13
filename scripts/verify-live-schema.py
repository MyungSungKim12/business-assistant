"""Read-only check that recently applied Supabase tables are exposed."""

from __future__ import annotations

import sys

import httpx
from business_assistant_server.config import Settings


def main() -> int:
    settings = Settings()
    if settings.supabase_url is None or not settings.supabase_service_key:
        print("Supabase connection settings are missing.")
        return 2

    root = f"{str(settings.supabase_url).rstrip('/')}/rest/v1"
    headers = {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
    }
    checks = (
        ("031 customer product returns", "visit_product_returns", "id"),
        ("032 sale cart discounts", "sale_cart_discount_events", "id"),
        ("032 discount fields", "sale_carts", "discount_kind,discount_value"),
        ("033 daily closings", "visit_daily_closings", "id"),
        ("033 close adjustments", "visit_daily_close_adjustments", "id"),
        ("034 appointments", "appointments", "id,organization_id,status,start_at"),
        ("034 appointment staff", "appointment_staff", "id,organization_id"),
        ("035 wallet lifecycle", "customer_wallets", "lifecycle_status,lifecycle_version"),
        ("035 wallet audit", "wallet_lifecycle_events", "id,operation_id"),
        ("037 staff schedule version", "appointment_staff", "id,schedule_version"),
        (
            "037 staff working hours",
            "appointment_staff_working_hours",
            "id,organization_id,staff_id,weekday",
        ),
        (
            "037 staff time off",
            "appointment_staff_time_off",
            "id,organization_id,staff_id,status",
        ),
        (
            "038 appointment resources",
            "appointment_resources",
            "id,organization_id,kind,is_active,version",
        ),
        (
            "038 service resource requirements",
            "appointment_service_resource_requirements",
            "id,organization_id,service_id,kind,quantity",
        ),
        (
            "038 appointment resource assignments",
            "appointments",
            "id,organization_id,resource_ids",
        ),
    )
    failed = False
    try:
        with httpx.Client(timeout=8.0) as client:
            for label, table, columns in checks:
                response = client.get(
                    f"{root}/{table}",
                    params={"select": columns, "limit": "0"},
                    headers=headers,
                )
                success = response.status_code == 200
                print(f"{'PASS' if success else 'FAIL'} {label}: HTTP {response.status_code}")
                failed |= not success
    except httpx.HTTPError:
        print("Supabase schema check could not connect; no data was changed.")
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
