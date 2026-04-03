from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, Request
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
    OTLPLogExporter,
)
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http._log_exporter import (
    OTLPLogExporter as OTLPHTTPLogExporter,
)
from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
    OTLPMetricExporter as OTLPHTTPMetricExporter,
)
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as OTLPHTTPSpanExporter,
)
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.semconv.resource import ResourceAttributes
from opentelemetry.trace import Span
from opentelemetry.trace.status import Status, StatusCode

from src.config import Settings
from src.utils.observability import TelemetryLogExclusionFilter


logger = logging.getLogger("vectorizer.telemetry")

OTLPSignal = Literal["traces", "metrics", "logs"]


class RequestMetricsRecorder(Protocol):
    def record_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: float,
    ) -> None: ...


class NoopRequestMetrics:
    def record_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: float,
    ) -> None:
        return None


class OTelRequestMetrics:
    def __init__(self, meter_provider: MeterProvider, service_name: str) -> None:
        meter = meter_provider.get_meter(service_name)
        self._request_total = meter.create_counter(
            name="vectorizer.http.server.requests",
            description="Total de requests HTTP recibidos por el backend.",
            unit="1",
        )
        self._request_by_status = meter.create_counter(
            name="vectorizer.http.server.responses",
            description="Requests HTTP agrupados por status code.",
            unit="1",
        )
        self._request_duration = meter.create_histogram(
            name="vectorizer.http.server.request.duration",
            description="Duración de requests HTTP del backend.",
            unit="ms",
        )

    def record_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: float,
    ) -> None:
        request_attributes = {
            "http.request.method": method,
            "http.route": path,
        }
        response_attributes = {
            **request_attributes,
            "http.response.status_code": status_code,
        }

        self._request_total.add(1, attributes=request_attributes)
        self._request_by_status.add(1, attributes=response_attributes)
        self._request_duration.record(duration_ms, attributes=response_attributes)


def parse_otel_headers(raw_headers: str) -> dict[str, str]:
    headers: dict[str, str] = {}

    for segment in raw_headers.split(","):
        chunk = segment.strip()
        if not chunk:
            continue

        key, separator, value = chunk.partition("=")
        normalized_key = key.strip()
        normalized_value = value.strip()
        if separator and normalized_key and normalized_value:
            headers[normalized_key] = normalized_value

    return headers


def build_resource(settings: Settings) -> Resource:
    return Resource.create(
        {
            ResourceAttributes.SERVICE_NAME: settings.service_name,
            ResourceAttributes.SERVICE_VERSION: settings.service_version,
            ResourceAttributes.DEPLOYMENT_ENVIRONMENT: settings.deployment_environment,
        }
    )


def build_grpc_exporter_kwargs(settings: Settings) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}

    if settings.otel_exporter_otlp_endpoint:
        kwargs["endpoint"] = settings.otel_exporter_otlp_endpoint

    headers = parse_otel_headers(settings.otel_exporter_otlp_headers)
    if headers:
        kwargs["headers"] = headers

    kwargs["insecure"] = settings.otel_exporter_otlp_insecure
    return kwargs


def build_http_exporter_endpoint(endpoint: str, signal: OTLPSignal) -> str:
    parsed = urlsplit(endpoint)
    signal_path = f"/v1/{signal}"
    normalized_path = parsed.path.rstrip("/")

    if normalized_path.endswith(("/v1/traces", "/v1/metrics")):
        base_path, _, _ = normalized_path.rpartition("/v1/")
        final_path = f"{base_path}{signal_path}" or signal_path
    else:
        final_path = (
            f"{normalized_path}{signal_path}" if normalized_path else signal_path
        )

    return urlunsplit(parsed._replace(path=final_path))


def build_http_exporter_kwargs(
    settings: Settings, signal: OTLPSignal
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}

    if settings.otel_exporter_otlp_endpoint:
        kwargs["endpoint"] = build_http_exporter_endpoint(
            settings.otel_exporter_otlp_endpoint,
            signal,
        )

    headers = parse_otel_headers(settings.otel_exporter_otlp_headers)
    if headers:
        kwargs["headers"] = headers

    return kwargs


def build_trace_exporter(settings: Settings):
    if settings.otel_exporter_protocol == "http/protobuf":
        return OTLPHTTPSpanExporter(**build_http_exporter_kwargs(settings, "traces"))

    return OTLPSpanExporter(**build_grpc_exporter_kwargs(settings))


def build_metric_exporter(settings: Settings):
    if settings.otel_exporter_protocol == "http/protobuf":
        return OTLPHTTPMetricExporter(**build_http_exporter_kwargs(settings, "metrics"))

    return OTLPMetricExporter(**build_grpc_exporter_kwargs(settings))


def build_log_exporter(settings: Settings):
    if settings.otel_exporter_protocol == "http/protobuf":
        return OTLPHTTPLogExporter(**build_http_exporter_kwargs(settings, "logs"))

    return OTLPLogExporter(**build_grpc_exporter_kwargs(settings))


def annotate_span_from_request(
    span: Span, request: Request, request_id_header: str
) -> None:
    if not span.is_recording():
        return

    request_id = getattr(request.state, "request_id", None) or request.headers.get(
        request_id_header
    )
    if request_id:
        span.set_attribute("app.request_id", request_id)


def annotate_span_from_response(span: Span, status_code: int) -> None:
    if not span.is_recording():
        return

    if status_code >= 500:
        span.set_status(Status(status_code=StatusCode.ERROR))


def configure_telemetry(app: FastAPI, settings: Settings) -> None:
    app.state.request_metrics = NoopRequestMetrics()
    app.state.telemetry_shutdown = []
    app.state.telemetry_log_handler = None

    if not settings.telemetry_enabled:
        logger.info("OpenTelemetry disabled by settings.")
        return

    resource = build_resource(settings)

    tracer_provider = TracerProvider(resource=resource)
    meter_provider = MeterProvider(resource=resource)
    logger_provider = LoggerProvider(resource=resource)

    if settings.otel_exporter_otlp_endpoint:
        tracer_provider.add_span_processor(
            BatchSpanProcessor(build_trace_exporter(settings))
        )
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(build_log_exporter(settings))
        )
        metric_reader = PeriodicExportingMetricReader(build_metric_exporter(settings))
        meter_provider = MeterProvider(
            resource=resource, metric_readers=[metric_reader]
        )
        set_logger_provider(logger_provider)
        logging_handler = LoggingHandler(
            level=logging.INFO,
            logger_provider=logger_provider,
        )
        logging_handler.addFilter(TelemetryLogExclusionFilter())
        root_logger = logging.getLogger()
        root_logger.addHandler(logging_handler)
        app.state.telemetry_log_handler = logging_handler
        logger.info(
            "OpenTelemetry OTLP exporter configured.",
            extra={
                "endpoint": settings.otel_exporter_otlp_endpoint,
                "protocol": settings.otel_exporter_protocol,
            },
        )
    else:
        logger.info(
            "OpenTelemetry enabled without OTLP exporter. Configure OTEL_EXPORTER_OTLP_ENDPOINT to send data to SigNoz."
        )

    app.state.request_metrics = OTelRequestMetrics(
        meter_provider, settings.service_name
    )
    app.state.telemetry_shutdown = [
        tracer_provider.shutdown,
        meter_provider.shutdown,
        logger_provider.shutdown,
    ]

    FastAPIInstrumentor.instrument_app(
        app,
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
    )


def record_request_metrics(
    app: FastAPI,
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
) -> None:
    recorder = getattr(app.state, "request_metrics", NoopRequestMetrics())
    recorder.record_request(
        method=method,
        path=path,
        status_code=status_code,
        duration_ms=duration_ms,
    )


def shutdown_telemetry(app: FastAPI) -> None:
    logging_handler = getattr(app.state, "telemetry_log_handler", None)
    if logging_handler is not None:
        root_logger = logging.getLogger()
        root_logger.removeHandler(logging_handler)

    shutdown_callbacks: list[Callable[[], object]] = getattr(
        app.state, "telemetry_shutdown", []
    )
    for callback in shutdown_callbacks:
        callback()
