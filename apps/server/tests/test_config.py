from business_assistant_server.config import Settings


def test_settings_have_safe_local_defaults() -> None:
    settings = Settings(_env_file=None)

    assert settings.environment == "development"
    assert settings.supabase_url is None
    assert settings.supabase_service_key is None
