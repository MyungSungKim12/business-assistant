from fastapi import FastAPI

from business_assistant_server.api.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="Business Assistant API", version="0.1.0")
    app.include_router(health_router, prefix="/api/v1")
    return app
