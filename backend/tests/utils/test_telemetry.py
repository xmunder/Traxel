from __future__ import annotations

from src.config import Settings
from src.utils.telemetry import (
    build_grpc_exporter_kwargs,
    build_http_exporter_endpoint,
    build_http_exporter_kwargs,
)


def test_build_grpc_exporter_kwargs_keeps_raw_endpoint_and_insecure_flag() -> None:
    settings = Settings(
        otel_exporter_otlp_endpoint="localhost:4317",
        otel_exporter_otlp_headers="authorization=Bearer token,x-tenant-id=test",
        otel_exporter_otlp_insecure=False,
    )

    assert build_grpc_exporter_kwargs(settings) == {
        "endpoint": "localhost:4317",
        "headers": {
            "authorization": "Bearer token",
            "x-tenant-id": "test",
        },
        "insecure": False,
    }


def test_build_http_exporter_endpoint_appends_signal_path_for_base_collector_url() -> (
    None
):
    endpoint = build_http_exporter_endpoint("http://127.0.0.1:4318", "traces")

    assert endpoint == "http://127.0.0.1:4318/v1/traces"


def test_build_http_exporter_endpoint_replaces_existing_signal_path() -> None:
    endpoint = build_http_exporter_endpoint(
        "http://127.0.0.1:4318/v1/traces",
        "metrics",
    )

    assert endpoint == "http://127.0.0.1:4318/v1/metrics"


def test_build_http_exporter_kwargs_uses_signal_specific_endpoint_without_insecure() -> (
    None
):
    settings = Settings(
        otel_exporter_protocol="http/protobuf",
        otel_exporter_otlp_endpoint="http://127.0.0.1:4318",
        otel_exporter_otlp_headers="authorization=Bearer token",
        otel_exporter_otlp_insecure=False,
    )

    assert build_http_exporter_kwargs(settings, "metrics") == {
        "endpoint": "http://127.0.0.1:4318/v1/metrics",
        "headers": {"authorization": "Bearer token"},
    }
