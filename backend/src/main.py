from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from time import perf_counter

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import get_settings
from src.routes.health import router as health_router
from src.routes.vectorize import router as vectorize_router
from src.utils.observability import (
    JsonLogFormatter,
    RequestContextFilter,
    bind_request_id,
    build_request_id,
    reset_request_id,
)


logger = logging.getLogger("vectorizer")


def configure_logging() -> None:
    settings = get_settings()
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    handler.addFilter(RequestContextFilter())

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.filters.clear()
    root_logger.setLevel(log_level)
    root_logger.addFilter(RequestContextFilter())
    root_logger.addHandler(handler)


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()

    @asynccontextmanager
    async def app_lifespan(app: FastAPI):
        yield

    app = FastAPI(
        title="Vectorizer Backend",
        version=settings.service_version,
        lifespan=app_lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allow_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def observability_middleware(request, call_next):
        request_id = build_request_id(request.headers.get(settings.request_id_header))
        request.state.request_id = request_id
        token = bind_request_id(request_id)
        started_at = perf_counter()

        try:
            response = await call_next(request)
        except Exception as exc:
            duration_ms = int((perf_counter() - started_at) * 1000)
            logger.exception(
                "Request failed before response",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": duration_ms,
                    "error_type": type(exc).__name__,
                    "error_detail": str(exc),
                },
            )
            raise
        finally:
            reset_request_id(token)

        duration_ms = round((perf_counter() - started_at) * 1000, 3)
        response.headers[settings.request_id_header] = request_id
        response.headers[settings.process_time_header] = str(int(duration_ms))
        logger.info(
            "Request completed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": int(duration_ms),
            },
        )
        return response

    app.include_router(health_router)
    app.include_router(vectorize_router)
    return app


app = create_app()
