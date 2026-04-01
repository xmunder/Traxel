from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings for the backend MVP."""

    model_config = SettingsConfigDict(extra="ignore")

    log_level: str = "INFO"
    max_file_size: int = 5 * 1024 * 1024
    default_max_colors: int = 8
    allowed_extensions: tuple[str, ...] = ("png", "jpg", "jpeg", "webp")
    allowed_content_types: tuple[str, ...] = ("image/png", "image/jpeg", "image/webp")
    cors_allow_origins: tuple[str, ...] = (
        "http://localhost:4321",
        "http://127.0.0.1:4321",
        "http://localhost:4411",
        "http://127.0.0.1:4411",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
