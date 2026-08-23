from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from src.config import get_settings
from src.models.schemas import (
    ObsErrorItem,
    ObsErrorsResponse,
    ObsRequestItem,
    ObsRequestsResponse,
    ObsSummaryResponse,
    ObsTimeseriesResponse,
    ErrorResponse,
    status_message,
)
from src.utils.metrics_collector import MetricsCollector
from src.utils.obs_auth import session_store


router = APIRouter(prefix="/obs", tags=["observability"])

# Valid range presets — kept in sync with ObsStore._RANGE_DELTA.
_VALID_RANGES = frozenset(
    {"1m", "5m", "10m", "30m", "1h", "3h", "6h", "12h", "1d", "30d", "365d"}
)


def _get_collector(request: Request) -> MetricsCollector:
    collector: MetricsCollector | None = getattr(
        request.app.state, "metrics_collector", None
    )
    if collector is None:
        raise HTTPException(
            status_code=503, detail="Observability collector not available."
        )
    return collector


class LoginRequest(BaseModel):
    username: str
    password: str


def _require_auth(request: Request) -> None:
    """Require a live opaque session cookie for observability endpoints."""
    settings = get_settings()

    if not settings.obs_username or not settings.obs_secret:
        raise HTTPException(
            status_code=503,
            detail="Observability panel is not configured.",
        )

    token = request.cookies.get(settings.obs_session_cookie)
    if not session_store.valid(token):
        raise HTTPException(
            status_code=401,
            detail="Authentication required.",
        )


def _require_trusted_origin(request: Request) -> None:
    """Reject cross-site state changes even when the browser sends cookies."""
    origin = request.headers.get("origin")
    settings = get_settings()
    if origin is None or origin not in settings.effective_cors_allow_origins:
        raise HTTPException(status_code=403, detail="Untrusted request origin.")


def _credentials_match(username: str, password: str) -> bool:
    settings = get_settings()
    username_ok = secrets.compare_digest(
        username.encode("utf-8"),
        settings.obs_username.encode("utf-8"),
    )
    password_ok = secrets.compare_digest(
        password.encode("utf-8"),
        settings.obs_secret.encode("utf-8"),
    )
    # Both comparisons above always execute before their results are combined.
    return bool(username_ok & password_ok)


@router.post(
    "/login",
    responses={
        401: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def login(
    payload: LoginRequest,
    response: Response,
    _: None = Depends(_require_trusted_origin),
) -> dict[str, bool]:
    settings = get_settings()
    if not settings.obs_username or not settings.obs_secret:
        raise HTTPException(status_code=503, detail="Observability panel is not configured.")
    if not _credentials_match(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    token = session_store.create(settings.obs_session_ttl_seconds)
    response.set_cookie(
        settings.obs_session_cookie,
        token,
        max_age=settings.obs_session_ttl_seconds,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    return {"authenticated": True}


@router.get(
    "/session",
    responses={401: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def session(request: Request) -> dict[str, bool]:
    _require_auth(request)
    return {"authenticated": True}


@router.post(
    "/logout",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def logout(
    request: Request,
    response: Response,
    _: None = Depends(_require_auth),
    __: None = Depends(_require_trusted_origin),
) -> dict[str, bool]:
    settings = get_settings()
    session_store.invalidate(request.cookies.get(settings.obs_session_cookie))
    response.delete_cookie(settings.obs_session_cookie, path="/")
    return {"authenticated": False}


@router.get(
    "/summary",
    responses={401: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    summary="Metrics summary",
)
async def get_summary(
    request: Request,
    range: str = Query(default="12h", alias="range"),
    status: str = Query(default="all"),
    _: None = Depends(_require_auth),
) -> ObsSummaryResponse:
    collector = _get_collector(request)
    data = collector.snapshot_summary()

    persisted_total: int | None = None
    obs_store = getattr(request.app.state, "obs_store", None)
    if obs_store is not None:
        summary = await obs_store.query_summary(
            range_preset=range, status_filter=status
        )
        persisted_total = summary["total"]
        status_counts = summary["status_counts"]
    else:
        status_counts = {str(k): v for k, v in data["status_counts"].items()}

    return ObsSummaryResponse(
        total_requests=data["total_requests"],
        total_errors=data["total_errors"],
        status_counts=status_counts,
        path_counts=data["path_counts"],
        requests_buffer_size=data["requests_buffer_size"],
        errors_buffer_size=data["errors_buffer_size"],
        persisted_total=persisted_total,
    )


@router.get(
    "/requests",
    responses={401: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    summary="Recent requests",
)
async def get_requests(
    request: Request,
    range: str = Query(default=None, alias="range"),
    status: str = Query(default="all"),
    limit: int = Query(default=None, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _: None = Depends(_require_auth),
) -> ObsRequestsResponse:
    settings = get_settings()
    collector = _get_collector(request)

    obs_store = getattr(request.app.state, "obs_store", None)
    if obs_store is not None:
        effective_limit = limit if limit is not None else settings.obs_requests_limit
        rows = await obs_store.query_requests(
            range_preset=range,
            status_filter=status,
            limit=effective_limit,
            offset=offset,
        )
        return ObsRequestsResponse(
            items=[
                ObsRequestItem(**row, message=status_message(row["status_code"]))
                for row in rows
            ],
            total=len(rows),
        )

    # Fallback: in-memory deque (no SQLite configured)
    rows = collector.snapshot_requests(limit=limit or settings.obs_requests_limit)
    return ObsRequestsResponse(
        items=[
            ObsRequestItem(**row, message=status_message(row["status_code"]))
            for row in rows
        ],
        total=len(rows),
    )


@router.get(
    "/errors",
    responses={401: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    summary="Recent errors",
)
async def get_errors(
    request: Request,
    limit: int = Query(default=None, ge=1, le=1000),
    _: None = Depends(_require_auth),
) -> ObsErrorsResponse:
    settings = get_settings()
    collector = _get_collector(request)
    effective_limit = limit if limit is not None else settings.obs_errors_limit
    rows = collector.snapshot_errors(limit=effective_limit)
    return ObsErrorsResponse(
        items=[ObsErrorItem(**row) for row in rows],
        total=len(rows),
    )


@router.get(
    "/timeseries",
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
    summary="Bucketed request time-series",
)
async def get_timeseries(
    request: Request,
    range: str = Query(default="12h", alias="range"),
    status: str = Query(default="all"),
    from_ts: str | None = Query(default=None),
    to_ts: str | None = Query(default=None),
    _: None = Depends(_require_auth),
) -> ObsTimeseriesResponse:
    obs_store = getattr(request.app.state, "obs_store", None)
    if obs_store is None:
        raise HTTPException(
            status_code=503,
            detail="Time-series requires SQLite persistence. Set OBS_DB_PATH to enable.",
        )

    if range not in _VALID_RANGES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid range preset '{range}'. "
            f"Valid options: {sorted(_VALID_RANGES)}",
        )

    result = await obs_store.query_timeseries(
        range_preset=range, status_filter=status, from_ts=from_ts, to_ts=to_ts
    )

    from src.models.schemas import ObsTimeseriesBucket

    return ObsTimeseriesResponse(
        buckets=[ObsTimeseriesBucket(**b) for b in result["buckets"]],
        range=result["range"],
        bucket_width=result["bucket_width"],
        total=result["total"],
    )
