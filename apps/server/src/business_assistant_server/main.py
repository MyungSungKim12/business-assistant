from fastapi import FastAPI

from business_assistant_server.api.auth import router as auth_router
from business_assistant_server.api.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="Business Assistant API", version="0.1.0")
    app.include_router(health_router, prefix="/api/v1")
    app.include_router(auth_router, prefix="/api/v1")
    return app
