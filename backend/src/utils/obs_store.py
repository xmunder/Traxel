"""ObsStore — async SQLite persistence layer for observability data.

Uses aiosqlite with WAL mode for concurrent reads during writes.
Provides a bounded asyncio.Queue write buffer flushed in background batches.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import aiosqlite

# ---------------------------------------------------------------------------
# Bucket presets: (bucket_width_sql_modifier, bucket_label_format)
# Maps range_preset → (strftime_modifier, display_bucket_width)
# ---------------------------------------------------------------------------

# strftime format string used per bucket
_STRFTIME: dict[str, str] = {
    "1m": "%Y-%m-%dT%H:%M",  # 15s buckets → group by minute for small sets
    "5m": "%Y-%m-%dT%H:%M",
    "10m": "%Y-%m-%dT%H:%M",
    "30m": "%Y-%m-%dT%H:%M",
    "1h": "%Y-%m-%dT%H:%M",
    "3h": "%Y-%m-%dT%H:00",
    "6h": "%Y-%m-%dT%H:00",
    "12h": "%Y-%m-%dT%H:00",
    "1d": "%Y-%m-%dT%H:00",
    "30d": "%Y-%m-%d",
    "365d": "%Y-%m",
}

# Human-readable bucket_width returned in the response
_BUCKET_WIDTH: dict[str, str] = {
    "1m": "15s",
    "5m": "30s",
    "10m": "1m",
    "30m": "5m",
    "1h": "5m",
    "3h": "15m",
    "6h": "30m",
    "12h": "1h",
    "1d": "2h",
    "30d": "1d",
    "365d": "30d",
}

# Range preset → timedelta
_RANGE_DELTA: dict[str, timedelta] = {
    "1m": timedelta(minutes=1),
    "5m": timedelta(minutes=5),
    "10m": timedelta(minutes=10),
    "30m": timedelta(minutes=30),
    "1h": timedelta(hours=1),
    "3h": timedelta(hours=3),
    "6h": timedelta(hours=6),
    "12h": timedelta(hours=12),
    "1d": timedelta(days=1),
    "30d": timedelta(days=30),
    "365d": timedelta(days=365),
}

# Status filter → (min, max) exclusive upper bound
_STATUS_RANGE: dict[str, tuple[int, int]] = {
    "2xx": (200, 300),
    "3xx": (300, 400),
    "4xx": (400, 500),
    "5xx": (500, 600),
}


def _build_status_clause(status_filter: str) -> tuple[str, list[Any]]:
    """Return (sql_fragment, params) for a status family filter."""
    if status_filter == "all" or not status_filter:
        return ("", [])
    if status_filter.isdigit():
        return ("AND status_code = ?", [int(status_filter)])
    if status_filter not in _STATUS_RANGE:
        return ("", [])
    lo, hi = _STATUS_RANGE[status_filter]
    return ("AND status_code >= ? AND status_code < ?", [lo, hi])


def _now_utc() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class ObsStore:
    """Async SQLite store for HTTP request observability data."""

    def __init__(
        self,
        db_path: str = "data/obs.db",
        queue_maxsize: int = 1000,
        flush_batch_size: int = 100,
        flush_interval_s: float = 1.0,
    ) -> None:
        self.db_path = db_path
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(
            maxsize=queue_maxsize
        )
        self._flush_batch_size = flush_batch_size
        self._flush_interval_s = flush_interval_s
        # Shared connection — used only when db_path is :memory: so tests work.
        # For on-disk DBs we open a fresh connection per operation (thread-safe).
        self._shared_conn: aiosqlite.Connection | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @asynccontextmanager
    async def _connect(self):
        if self._shared_conn is not None:
            # In-memory mode: reuse the single shared connection.
            self._shared_conn.row_factory = aiosqlite.Row
            yield self._shared_conn
        else:
            async with aiosqlite.connect(self.db_path) as conn:
                conn.row_factory = aiosqlite.Row
                yield conn

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def init_db(self) -> None:
        """Create schema and indexes if they don't exist; enable WAL mode.

        For :memory: databases, opens and keeps a shared connection so that
        subsequent calls in the same store instance see the same data.
        """
        if self.db_path == ":memory:" and self._shared_conn is None:
            self._shared_conn = await aiosqlite.connect(self.db_path)
            self._shared_conn.row_factory = aiosqlite.Row

        async with self._connect() as conn:
            await conn.execute("PRAGMA journal_mode=WAL")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS requests (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp    TEXT NOT NULL,
                    method       TEXT NOT NULL,
                    path         TEXT NOT NULL,
                    status_code  INTEGER NOT NULL,
                    duration_ms  INTEGER NOT NULL
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_sc ON requests(status_code)"
            )
            await conn.commit()

    async def close(self) -> None:
        """Flush remaining rows and close."""
        await self.flush()
        if self._shared_conn is not None:
            await self._shared_conn.close()
            self._shared_conn = None

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    async def enqueue(
        self,
        *,
        timestamp: str,
        method: str,
        path: str,
        status_code: int,
        duration_ms: int,
    ) -> None:
        """Add a request record to the write queue (non-blocking)."""
        try:
            self._queue.put_nowait(
                {
                    "timestamp": timestamp,
                    "method": method,
                    "path": path,
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                }
            )
        except asyncio.QueueFull:
            pass  # drop on backpressure

    async def flush(self) -> None:
        """Drain the queue and persist all pending rows in a single transaction."""
        rows: list[dict[str, Any]] = []
        while not self._queue.empty():
            try:
                rows.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break

        if not rows:
            return

        async with self._connect() as conn:
            await conn.executemany(
                "INSERT OR IGNORE INTO requests (timestamp, method, path, status_code, duration_ms) "
                "VALUES (:timestamp, :method, :path, :status_code, :duration_ms)",
                rows,
            )
            await conn.commit()

    async def _flush_worker(self) -> None:
        """Background task: flush every `flush_interval_s` or when batch fills."""
        while True:
            await asyncio.sleep(self._flush_interval_s)
            await self.flush()

    # ------------------------------------------------------------------
    # Read path
    # ------------------------------------------------------------------

    async def query_summary(
        self,
        range_preset: str = "24h",
        status_filter: str = "all",
        now: str | None = None,
    ) -> dict[str, Any]:
        """Return aggregate summary optionally filtered by range and status."""
        where_parts = ["1=1"]
        params: list[Any] = []

        # Range filter
        if range_preset and range_preset != "all":
            delta = _RANGE_DELTA.get(range_preset)
            if delta:
                now_dt = (
                    datetime.fromisoformat(now)
                    if now
                    else datetime.now(tz=timezone.utc)
                )
                since = (now_dt - delta).isoformat()
                where_parts.append("timestamp >= ?")
                params.append(since)

        # Status filter
        status_clause, status_params = _build_status_clause(status_filter)
        if status_clause:
            where_parts.append(status_clause.lstrip("AND ").strip())
            params.extend(status_params)

        where = " AND ".join(where_parts)

        async with self._connect() as conn:
            # total
            async with conn.execute(
                f"SELECT COUNT(*) FROM requests WHERE {where}", params
            ) as cur:
                total = (await cur.fetchone())[0]

            # status breakdown
            async with conn.execute(
                f"SELECT status_code, COUNT(*) FROM requests WHERE {where} GROUP BY status_code",
                params,
            ) as cur:
                rows = await cur.fetchall()

        status_counts: dict[str, int] = {str(r[0]): r[1] for r in rows}

        return {
            "total": total,
            "status_counts": status_counts,
        }

    async def query_requests(
        self,
        range_preset: str | None = None,
        status_filter: str = "all",
        limit: int = 100,
        offset: int = 0,
        now: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return paginated list of requests ordered newest-first."""
        where_parts = ["1=1"]
        params: list[Any] = []

        if range_preset:
            delta = _RANGE_DELTA.get(range_preset)
            if delta:
                now_dt = (
                    datetime.fromisoformat(now)
                    if now
                    else datetime.now(tz=timezone.utc)
                )
                since = (now_dt - delta).isoformat()
                where_parts.append("timestamp >= ?")
                params.append(since)

        status_clause, status_params = _build_status_clause(status_filter)
        if status_clause:
            where_parts.append(status_clause.lstrip("AND ").strip())
            params.extend(status_params)

        where = " AND ".join(where_parts)

        async with self._connect() as conn:
            async with conn.execute(
                f"SELECT timestamp, method, path, status_code, duration_ms "
                f"FROM requests WHERE {where} "
                f"ORDER BY timestamp DESC LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ) as cur:
                rows = await cur.fetchall()

        return [
            {
                "timestamp": r["timestamp"],
                "method": r["method"],
                "path": r["path"],
                "status_code": r["status_code"],
                "duration_ms": r["duration_ms"],
            }
            for r in rows
        ]

    async def query_timeseries(
        self,
        range_preset: str = "12h",
        status_filter: str = "all",
        now: str | None = None,
        from_ts: str | None = None,
        to_ts: str | None = None,
    ) -> dict[str, Any]:
        """Return bucketed time-series counts.

        When *from_ts* and *to_ts* are provided they override the
        range_preset window, allowing callers to zoom into a custom
        time interval (e.g. brush selection on the histogram).
        """
        if range_preset not in _STRFTIME:
            raise ValueError(
                f"Invalid range_preset: {range_preset!r}. Must be one of {list(_STRFTIME)}"
            )

        strftime_fmt = _STRFTIME[range_preset]
        delta = _RANGE_DELTA[range_preset]
        bucket_width = _BUCKET_WIDTH[range_preset]

        now_dt = datetime.fromisoformat(now) if now else datetime.now(tz=timezone.utc)

        if from_ts and to_ts:
            since = from_ts
            since_until = to_ts
        else:
            since = (now_dt - delta).isoformat()
            since_until = now_dt.isoformat()

        params: list[Any] = [strftime_fmt, since, since_until]
        status_clause, status_params = _build_status_clause(status_filter)
        extra_where = ""
        if status_clause:
            extra_where = f" {status_clause}"
            params.extend(status_params)

        async with self._connect() as conn:
            async with conn.execute(
                f"SELECT strftime(?, timestamp) AS bucket, status_code, COUNT(*) AS cnt "
                f"FROM requests "
                f"WHERE timestamp >= ? AND timestamp < ?{extra_where} "
                f"GROUP BY bucket, status_code ORDER BY bucket, status_code",
                params,
            ) as cur:
                rows = await cur.fetchall()

        buckets_by_key: dict[str, dict[str, Any]] = {}
        for row in rows:
            bucket_key = row["bucket"]
            status_code = int(row["status_code"])
            count = int(row["cnt"])
            bucket = buckets_by_key.setdefault(
                bucket_key,
                {
                    "bucket": bucket_key,
                    "count": 0,
                    "status_counts": {},
                    "count_2xx": 0,
                    "count_3xx": 0,
                    "count_4xx": 0,
                    "count_5xx": 0,
                },
            )
            bucket["count"] += count
            bucket["status_counts"][str(status_code)] = count
            if 200 <= status_code < 300:
                bucket["count_2xx"] += count
            elif 300 <= status_code < 400:
                bucket["count_3xx"] += count
            elif 400 <= status_code < 500:
                bucket["count_4xx"] += count
            elif 500 <= status_code < 600:
                bucket["count_5xx"] += count

        buckets = list(buckets_by_key.values())
        total = sum(b["count"] for b in buckets)

        return {
            "buckets": buckets,
            "range": range_preset,
            "bucket_width": bucket_width,
            "total": total,
        }

    async def prune(self, retention_days: int = 30) -> None:
        """Delete rows older than `retention_days`."""
        cutoff = (
            datetime.now(tz=timezone.utc) - timedelta(days=retention_days)
        ).isoformat()
        async with self._connect() as conn:
            await conn.execute("DELETE FROM requests WHERE timestamp < ?", [cutoff])
            await conn.commit()
