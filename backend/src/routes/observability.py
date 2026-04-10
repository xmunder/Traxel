from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from src.config import get_settings
from src.models.schemas import (
    ObsErrorItem,
    ObsErrorsResponse,
    ObsRequestItem,
    ObsRequestsResponse,
    ObsSummaryResponse,
)
from src.utils.metrics_collector import MetricsCollector


router = APIRouter(prefix="/obs", tags=["observability"])
_security = HTTPBasic()


def _get_collector(request: Request) -> MetricsCollector:
    collector: MetricsCollector | None = getattr(
        request.app.state, "metrics_collector", None
    )
    if collector is None:
        raise HTTPException(
            status_code=503, detail="Observability collector not available."
        )
    return collector


def _require_auth(
    credentials: HTTPBasicCredentials = Depends(_security),
) -> None:
    """Validate HTTP Basic credentials against env-var config.

    Returns ``503`` when auth is not configured (both vars empty) so the
    panel remains invisible rather than returning ``401`` on unconfigured
    deployments.
    """
    settings = get_settings()

    if not settings.obs_username or not settings.obs_secret:
        raise HTTPException(
            status_code=503,
            detail="Observability panel is not configured.",
        )

    username_ok = secrets.compare_digest(
        credentials.username.encode("utf-8"),
        settings.obs_username.encode("utf-8"),
    )
    password_ok = secrets.compare_digest(
        credentials.password.encode("utf-8"),
        settings.obs_secret.encode("utf-8"),
    )

    if not (username_ok and password_ok):
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials.",
            headers={"WWW-Authenticate": "Basic"},
        )


@router.get(
    "/summary",
    response_model=ObsSummaryResponse,
    summary="Metrics summary",
)
async def get_summary(
    request: Request,
    _: None = Depends(_require_auth),
) -> ObsSummaryResponse:
    collector = _get_collector(request)
    data = collector.snapshot_summary()
    # Cast int keys to str for JSON-serialisable dict[str, int]
    return ObsSummaryResponse(
        total_requests=data["total_requests"],
        total_errors=data["total_errors"],
        status_counts={str(k): v for k, v in data["status_counts"].items()},
        path_counts=data["path_counts"],
        requests_buffer_size=data["requests_buffer_size"],
        errors_buffer_size=data["errors_buffer_size"],
    )


@router.get(
    "/requests",
    response_model=ObsRequestsResponse,
    summary="Recent requests",
)
async def get_requests(
    request: Request,
    _: None = Depends(_require_auth),
) -> ObsRequestsResponse:
    settings = get_settings()
    collector = _get_collector(request)
    rows = collector.snapshot_requests(limit=settings.obs_requests_limit)
    return ObsRequestsResponse(
        items=[ObsRequestItem(**row) for row in rows],
        total=len(rows),
    )


@router.get(
    "/errors",
    response_model=ObsErrorsResponse,
    summary="Recent errors",
)
async def get_errors(
    request: Request,
    _: None = Depends(_require_auth),
) -> ObsErrorsResponse:
    settings = get_settings()
    collector = _get_collector(request)
    rows = collector.snapshot_errors(limit=settings.obs_errors_limit)
    return ObsErrorsResponse(
        items=[ObsErrorItem(**row) for row in rows],
        total=len(rows),
    )
