from business_assistant_server.config import Settings


def test_settings_have_safe_local_defaults() -> None:
    settings = Settings(_env_file=None)

    assert settings.environment == "development"
    assert settings.supabase_url is None
    assert settings.supabase_publishable_key is None
    assert settings.supabase_service_key is None


def test_settings_load_documented_app_environment_variables(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("APP_ENVIRONMENT", "production")
    monkeypatch.setenv("APP_SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("APP_SUPABASE_PUBLISHABLE_KEY", "publishable-key")
    monkeypatch.setenv("APP_SUPABASE_SERVICE_KEY", "server-only-key")

    settings = Settings(_env_file=None)

    assert settings.environment == "production"
    assert str(settings.supabase_url) == "https://example.supabase.co/"
    assert settings.supabase_publishable_key == "publishable-key"
    assert settings.supabase_service_key == "server-only-key"


def test_settings_treat_blank_optional_app_values_as_none(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("APP_SUPABASE_URL", "")
    monkeypatch.setenv("APP_SUPABASE_PUBLISHABLE_KEY", "")
    monkeypatch.setenv("APP_SUPABASE_SERVICE_KEY", "")

    settings = Settings(_env_file=None)

    assert settings.supabase_url is None
    assert settings.supabase_publishable_key is None
    assert settings.supabase_service_key is None
