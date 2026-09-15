from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="APP_",
        env_ignore_empty=True,
        extra="ignore",
    )

    environment: str = "development"
    supabase_url: AnyHttpUrl | None = None
    supabase_service_key: str | None = None
