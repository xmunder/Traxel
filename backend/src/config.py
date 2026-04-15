from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _parse_csv(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split(",") if item.strip())


class Settings(BaseSettings):
    """Runtime settings for the backend MVP."""

    model_config = SettingsConfigDict(extra="ignore")

    service_name: str = "vectorizer-backend"
    service_version: str = "0.1.0"
    deployment_environment: Literal["development", "staging", "production"] = (
        "development"
    )
    log_level: str = "INFO"
    request_id_header: str = "X-Request-ID"
    process_time_header: str = "X-Process-Time-MS"
    max_file_size: int = 5 * 1024 * 1024
    processing_max_dimension: int = 1024
    default_max_colors: int = 8
    allowed_extensions: tuple[str, ...] = ("png", "jpg", "jpeg", "webp")
    allowed_content_types: tuple[str, ...] = ("image/png", "image/jpeg", "image/webp")
    cors_allow_origins: tuple[str, ...] = _parse_csv(
        "http://localhost:4321,"
        "http://127.0.0.1:4321,"
        "http://localhost:4411,"
        "http://127.0.0.1:4411,"
        "https://traxel.pages.dev"
    )

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def parse_cors_allow_origins(cls, value: str | tuple[str, ...]) -> tuple[str, ...]:
        if isinstance(value, str):
            return _parse_csv(value)
        return value

    # ------------------------------------------------------------------ #
    # Observability panel                                                  #
    # ------------------------------------------------------------------ #
    # Set both OBS_USERNAME and OBS_SECRET in the environment to enable
    # the /obs/* endpoints.  If either is empty the endpoints return 503.
    obs_username: str = ""
    obs_secret: str = ""

    # Maximum entries returned by /obs/requests and /obs/errors.
    obs_requests_limit: int = 200
    obs_errors_limit: int = 100

    # Soft cap on distinct path labels tracked in path_counts to prevent
    # unbounded growth when many unknown paths are hit.
    obs_path_label_limit: int = 50

    # ------------------------------------------------------------------ #
    # Observability persistence (SQLite)                                   #
    # ------------------------------------------------------------------ #
    # Path to the SQLite DB file.  Set to "" to disable persistence and
    # fall back to in-memory deque behaviour (legacy mode).
    obs_db_path: str = "data/obs.db"

    # Retention: rows older than this many days are pruned on startup + daily.
    obs_retention_days: int = 30

    # Background flush interval (seconds).
    obs_flush_interval_s: float = 1.0

    # Batch size: flush at most this many rows per transaction.
    obs_flush_batch_size: int = 100


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
