from uuid import UUID

from pydantic import AnyHttpUrl, field_validator
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
    supabase_publishable_key: str | None = None
    supabase_service_key: str | None = None
    file_bucket: str = "business-files"
    platform_admin_user_ids: frozenset[UUID] = frozenset()

    @field_validator("platform_admin_user_ids", mode="before")
    @classmethod
    def parse_platform_admin_user_ids(cls, value: object) -> frozenset[UUID]:
        if value is None or value == "":
            return frozenset()
        if isinstance(value, str):
            return frozenset(UUID(item.strip()) for item in value.split(",") if item.strip())
        if isinstance(value, frozenset):
            return value
        raise ValueError("platform admin user IDs must be comma-separated UUIDs")
