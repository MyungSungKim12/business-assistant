from business_assistant_common.models import HealthStatus


def test_health_status_serializes_service_state() -> None:
    status = HealthStatus(service="business-assistant-server", status="ok")
    assert status.model_dump() == {
        "service": "business-assistant-server",
        "status": "ok",
    }
