from business_assistant_server.main import create_app
from fastapi.testclient import TestClient


def test_health_endpoint_is_available_without_supabase() -> None:
    client = TestClient(create_app())

    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "service": "business-assistant-server",
        "status": "ok",
    }
