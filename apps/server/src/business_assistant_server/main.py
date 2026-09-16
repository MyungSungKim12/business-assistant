from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from business_assistant_server.api.admin import router as admin_router
from business_assistant_server.api.auth import router as auth_router
from business_assistant_server.api.customers import router as customer_router
from business_assistant_server.api.documents import router as document_router
from business_assistant_server.api.finance import router as finance_router
from business_assistant_server.api.entitlements import FeatureAccessDenied
from business_assistant_server.api.entitlements import router as entitlement_router
from business_assistant_server.api.health import router as health_router
from business_assistant_server.api.organizations import router as organization_router
from business_assistant_server.api.tasks import router as task_router


def create_app() -> FastAPI:
    app = FastAPI(title="Business Assistant API", version="0.1.0")
    app.include_router(health_router, prefix="/api/v1")
    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(admin_router, prefix="/api/v1")
    app.include_router(organization_router, prefix="/api/v1")
    app.include_router(entitlement_router, prefix="/api/v1")
    app.include_router(customer_router, prefix="/api/v1")
    app.include_router(task_router, prefix="/api/v1")
    app.include_router(document_router, prefix="/api/v1")
    app.include_router(finance_router, prefix="/api/v1")

    @app.exception_handler(FeatureAccessDenied)
    async def feature_access_denied_handler(
        request: Request, error: FeatureAccessDenied
    ) -> JSONResponse:
        return JSONResponse(
            status_code=403,
            content={"detail": "Feature not available", "feature_code": error.feature_code},
        )

    return app
