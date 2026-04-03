from __future__ import annotations

import json
import logging
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from uuid import uuid4


REQUEST_ID_CONTEXT: ContextVar[str | None] = ContextVar("request_id", default=None)

STRUCTURED_LOG_FIELDS = (
    "request_id",
    "event",
    "method",
    "path",
    "status_code",
    "duration_ms",
    "content_type",
    "size_bytes",
    "colors_detected",
    "paths_generated",
    "error_type",
    "error_detail",
)


EXCLUDED_OTEL_LOGGER_PREFIXES = (
    "opentelemetry",
    "grpc",
)


def build_request_id(candidate: str | None) -> str:
    if candidate:
        normalized = candidate.strip()
        if normalized:
            return normalized

    return uuid4().hex


def bind_request_id(request_id: str) -> Token[str | None]:
    return REQUEST_ID_CONTEXT.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    REQUEST_ID_CONTEXT.reset(token)


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = (
            getattr(record, "request_id", None) or REQUEST_ID_CONTEXT.get()
        )
        record.event = getattr(record, "event", None) or record.getMessage()

        for field in STRUCTURED_LOG_FIELDS:
            if not hasattr(record, field):
                setattr(record, field, None)

        return True


class TelemetryLogExclusionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith(EXCLUDED_OTEL_LOGGER_PREFIXES)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": record.event,
            "request_id": record.request_id,
            "filename": record.filename,
        }

        for field in STRUCTURED_LOG_FIELDS:
            value = getattr(record, field, None)
            if value is not None and field not in payload:
                payload[field] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False)
