from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
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
    # Bound processing cost and output complexity for untrusted images.
    processing_max_dimension: int = 512
    # Maximum contour deviation in processing pixels; zero disables simplification.
    contour_simplify_tolerance: float = Field(default=0.5, ge=0, le=2, allow_inf_nan=False)
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
    trusted_hosts: tuple[str, ...] = _parse_csv(
        "localhost,127.0.0.1,testserver,traxel.pages.dev,*.traxel.pages.dev,traxel-api.cglabs.site"
    )

    @field_validator("cors_allow_origins", "trusted_hosts", mode="before")
    @classmethod
    def parse_csv_settings(cls, value: str | tuple[str, ...]) -> tuple[str, ...]:
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
    # Sessions are process-local by design; use a shared store before scaling
    # the backend horizontally.
    obs_session_cookie: str = "obs_session"
    obs_session_ttl_seconds: int = 3600
    # The in-memory store is intentionally bounded because it is process-local.
    obs_session_max_sessions: int = 1024
    obs_cookie_secure: bool | None = None
    obs_login_rate_limit: int = 5
    obs_login_rate_window_seconds: int = 60
    vectorize_rate_limit: int = 20
    vectorize_rate_window_seconds: int = 60
    rate_limit_max_keys: int = 10_000
    obs_max_image_pixels: int = 16_777_216
    obs_max_image_dimension: int = 8192

    @property
    def session_cookie_secure(self) -> bool:
        return self.obs_cookie_secure if self.obs_cookie_secure is not None else self.deployment_environment == "production"

    @property
    def session_cookie_samesite(self) -> str:
        return "none" if self.deployment_environment == "production" else "lax"

    @property
    def effective_cors_allow_origins(self) -> tuple[str, ...]:
        if self.deployment_environment == "production":
            return tuple(
                origin
                for origin in self.cors_allow_origins
                if not origin.startswith(("http://localhost", "http://127.0.0.1"))
            )
        return self.cors_allow_origins

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
