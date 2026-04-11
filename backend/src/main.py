from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
import os
from time import perf_counter

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import get_settings
from src.routes.health import router as health_router
from src.routes.observability import router as observability_router
from src.routes.vectorize import router as vectorize_router
from src.utils.metrics_collector import MetricsCollector
from src.utils.obs_store import ObsStore
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
        collector = MetricsCollector(
            requests_limit=settings.obs_requests_limit,
            errors_limit=settings.obs_errors_limit,
            path_label_limit=settings.obs_path_label_limit,
        )
        app.state.metrics_collector = collector

        obs_store: ObsStore | None = None
        flush_task: asyncio.Task | None = None
        prune_task: asyncio.Task | None = None

        if settings.obs_db_path:
            # Ensure data directory exists
            data_dir = os.path.dirname(settings.obs_db_path)
            if data_dir:
                os.makedirs(data_dir, exist_ok=True)

            obs_store = ObsStore(
                db_path=settings.obs_db_path,
                flush_interval_s=settings.obs_flush_interval_s,
                flush_batch_size=settings.obs_flush_batch_size,
            )
            await obs_store.init_db()
            await obs_store.prune(retention_days=settings.obs_retention_days)

            # Wire the store into the collector
            collector.obs_store = obs_store
            app.state.obs_store = obs_store

            # Start background workers
            flush_task = asyncio.create_task(obs_store._flush_worker())

            async def _daily_prune():
                while True:
                    await asyncio.sleep(86400)
                    await obs_store.prune(retention_days=settings.obs_retention_days)

            prune_task = asyncio.create_task(_daily_prune())

        yield

        # Shutdown — drain and close
        for task in (flush_task, prune_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        if obs_store is not None:
            await obs_store.close()

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

        # Exclude /obs/* traffic from metrics to avoid recursive inflation.
        is_obs_path = request.url.path.startswith("/obs")

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
            if not is_obs_path:
                collector: MetricsCollector | None = getattr(
                    app.state, "metrics_collector", None
                )
                if collector is not None:
                    collector.record_error(
                        method=request.method,
                        path=request.url.path,
                        error_type=type(exc).__name__,
                        error_detail=str(exc),
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

        if not is_obs_path:
            collector = getattr(app.state, "metrics_collector", None)
            if collector is not None:
                collector.record_request(
                    method=request.method,
                    path=request.url.path,
                    status_code=response.status_code,
                    duration_ms=int(duration_ms),
                )

        return response

    app.include_router(health_router)
    app.include_router(vectorize_router)
    app.include_router(observability_router)
    return app


app = create_app()
