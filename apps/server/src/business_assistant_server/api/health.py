from business_assistant_common.models import HealthStatus
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def get_health() -> HealthStatus:
    return HealthStatus(service="business-assistant-server", status="ok")
