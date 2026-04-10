from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


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
    telemetry_enabled: bool = True
    otel_exporter_protocol: Literal["grpc", "http/protobuf"] = "grpc"
    otel_exporter_otlp_endpoint: str | None = None
    otel_exporter_otlp_headers: str = ""
    otel_exporter_otlp_insecure: bool = True
    max_file_size: int = 5 * 1024 * 1024
    processing_max_dimension: int = 1024
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
