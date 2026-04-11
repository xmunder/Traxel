from __future__ import annotations

import asyncio
import threading
from collections import deque
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.utils.obs_store import ObsStore

# Paths we actually care about for aggregation.
# Keeps path_counts bounded — no unbounded growth from arbitrary paths.
_PATH_WHITELIST: frozenset[str] = frozenset(
    {
        "/vectorize",
        "/health",
    }
)

_PATH_LABEL_OTHER = "other"


def _normalize_path(path: str, path_label_limit: int) -> str:
    """Return a stable label for *path*, respecting the whitelist."""
    if path in _PATH_WHITELIST:
        return path
    return _PATH_LABEL_OTHER


class RequestRecord:
    __slots__ = ("timestamp", "method", "path", "status_code", "duration_ms")

    def __init__(
        self,
        *,
        timestamp: str,
        method: str,
        path: str,
        status_code: int,
        duration_ms: int,
    ) -> None:
        self.timestamp = timestamp
        self.method = method
        self.path = path
        self.status_code = status_code
        self.duration_ms = duration_ms

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "method": self.method,
            "path": self.path,
            "status_code": self.status_code,
            "duration_ms": self.duration_ms,
        }


class ErrorRecord:
    __slots__ = ("timestamp", "method", "path", "error_type", "error_detail")

    def __init__(
        self,
        *,
        timestamp: str,
        method: str,
        path: str,
        error_type: str,
        error_detail: str,
    ) -> None:
        self.timestamp = timestamp
        self.method = method
        self.path = path
        self.error_type = error_type
        self.error_detail = error_detail

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "method": self.method,
            "path": self.path,
            "error_type": self.error_type,
            "error_detail": self.error_detail,
        }


class MetricsCollector:
    """In-memory metrics collector — no external dependencies.

    Thread-safe via a single ``threading.Lock``.  Uses ``deque(maxlen=N)``
    for bounded ring buffers so memory usage stays predictable.

    When ``obs_store`` is set (an :class:`ObsStore` instance), each
    :meth:`record_request` call also enqueues the row for SQLite persistence.
    Errors always stay in-memory only (low volume, not queried by timeseries).
    """

    def __init__(
        self,
        *,
        requests_limit: int = 200,
        errors_limit: int = 100,
        path_label_limit: int = 50,
    ) -> None:
        self._requests_limit = requests_limit
        self._errors_limit = errors_limit
        self._path_label_limit = path_label_limit

        self._lock = threading.Lock()
        self._requests: deque[RequestRecord] = deque(maxlen=requests_limit)
        self._errors: deque[ErrorRecord] = deque(maxlen=errors_limit)

        self._total_requests: int = 0
        self._total_errors: int = 0
        self._status_counts: dict[int, int] = {}
        self._path_counts: dict[str, int] = {}

        # Optional persistence adapter — set after construction by lifespan.
        self.obs_store: ObsStore | None = None

    # ------------------------------------------------------------------
    # Write path (called from middleware)
    # ------------------------------------------------------------------

    def record_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: int,
    ) -> None:
        timestamp = datetime.now(tz=timezone.utc).isoformat()
        label = _normalize_path(path, self._path_label_limit)

        record = RequestRecord(
            timestamp=timestamp,
            method=method,
            path=path,
            status_code=status_code,
            duration_ms=duration_ms,
        )

        with self._lock:
            self._requests.append(record)
            self._total_requests += 1
            self._status_counts[status_code] = (
                self._status_counts.get(status_code, 0) + 1
            )
            self._path_counts[label] = self._path_counts.get(label, 0) + 1

        # Async persistence — fire-and-forget without blocking the request path.
        # Uses get_running_loop() which only succeeds when called from within a
        # running event loop (e.g. inside an ASGI request cycle). If no loop is
        # running (e.g. sync tests), falls back to run_until_complete so the
        # enqueue is still exercised and tests can assert on it.
        if self.obs_store is not None:
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(
                    self.obs_store.enqueue(
                        timestamp=timestamp,
                        method=method,
                        path=path,
                        status_code=status_code,
                        duration_ms=duration_ms,
                    )
                )
            except RuntimeError:
                # No running loop — run synchronously (test / CLI context).
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_closed():
                        raise RuntimeError("closed")
                except RuntimeError:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(
                        self.obs_store.enqueue(
                            timestamp=timestamp,
                            method=method,
                            path=path,
                            status_code=status_code,
                            duration_ms=duration_ms,
                        )
                    )
                except Exception:
                    pass  # Never let persistence errors affect the request path
            except Exception:
                pass  # Never let persistence errors affect the request path

    def record_error(
        self,
        *,
        method: str,
        path: str,
        error_type: str,
        error_detail: str,
    ) -> None:
        timestamp = datetime.now(tz=timezone.utc).isoformat()

        record = ErrorRecord(
            timestamp=timestamp,
            method=method,
            path=path,
            error_type=error_type,
            error_detail=error_detail,
        )

        with self._lock:
            self._errors.append(record)
            self._total_errors += 1

    # ------------------------------------------------------------------
    # Read path (called from /obs/* endpoints)
    # ------------------------------------------------------------------

    def snapshot_summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "total_requests": self._total_requests,
                "total_errors": self._total_errors,
                "status_counts": dict(self._status_counts),
                "path_counts": dict(self._path_counts),
                "requests_buffer_size": len(self._requests),
                "errors_buffer_size": len(self._errors),
            }

    def snapshot_requests(self, limit: int | None = None) -> list[dict[str, Any]]:
        with self._lock:
            records = list(self._requests)

        records.reverse()  # most-recent first — outside the lock
        if limit is not None:
            records = records[:limit]
        return [r.to_dict() for r in records]

    def snapshot_errors(self, limit: int | None = None) -> list[dict[str, Any]]:
        with self._lock:
            records = list(self._errors)

        records.reverse()  # most-recent first — outside the lock
        if limit is not None:
            records = records[:limit]
        return [r.to_dict() for r in records]
