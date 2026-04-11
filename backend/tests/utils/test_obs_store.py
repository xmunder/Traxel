"""Tests for ObsStore — async SQLite persistence layer.

All tests use an in-memory SQLite DB (:memory:) via aiosqlite.
Requires `pytest-asyncio` or running under asyncio.

Strategy: use `asyncio.run()` directly in a helper so we stay compatible
with the existing `pytest` setup (no pytest-asyncio dependency needed).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from src.utils.obs_store import ObsStore


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #


def run(coro):
    """Run an async coroutine synchronously.

    Reuses or creates the current thread's event loop so that aiosqlite
    connections (including shared `:memory:` connections) remain valid
    across multiple `run()` calls within the same test.  After previous
    test-client teardown (anyio closes the loop), we create a fresh one.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("loop is closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def make_store(**kwargs):
    """Return an ObsStore backed by an in-memory SQLite DB."""
    from src.utils.obs_store import ObsStore

    db_path = kwargs.pop("db_path", ":memory:")
    store = ObsStore(db_path=db_path, **kwargs)
    run(store.init_db())
    return store


def _ts(offset_s: float = 0.0) -> str:
    """Return ISO-8601 UTC timestamp, optionally offset by `offset_s` seconds."""
    from datetime import timedelta

    base = datetime(2026, 4, 10, 12, 0, 0, tzinfo=timezone.utc)
    return (base + timedelta(seconds=offset_s)).isoformat()


# ------------------------------------------------------------------ #
# 1. Schema initialisation                                             #
# ------------------------------------------------------------------ #


class TestInitDb:
    def test_init_creates_requests_table(self) -> None:
        store = make_store()

        async def check():
            async with store._connect() as conn:
                async with conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='requests'"
                ) as cur:
                    row = await cur.fetchone()
            return row

        row = run(check())
        assert row is not None
        assert row[0] == "requests"

    def test_init_creates_indexes(self) -> None:
        store = make_store()

        async def check():
            async with store._connect() as conn:
                async with conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                ) as cur:
                    rows = await cur.fetchall()
            return [r[0] for r in rows]

        indexes = run(check())
        assert "idx_requests_ts" in indexes
        assert "idx_requests_sc" in indexes


# ------------------------------------------------------------------ #
# 2. enqueue / flush                                                   #
# ------------------------------------------------------------------ #


class TestEnqueueFlush:
    def test_enqueue_and_flush_persists_row(self) -> None:
        store = make_store()

        async def go():
            await store.enqueue(
                timestamp=_ts(),
                method="GET",
                path="/health",
                status_code=200,
                duration_ms=5,
            )
            await store.flush()
            async with store._connect() as conn:
                async with conn.execute("SELECT COUNT(*) FROM requests") as cur:
                    row = await cur.fetchone()
            return row[0]

        count = run(go())
        assert count == 1

    def test_multiple_rows_persisted(self) -> None:
        store = make_store()

        async def go():
            for i in range(5):
                await store.enqueue(
                    timestamp=_ts(i),
                    method="POST",
                    path="/vectorize",
                    status_code=200,
                    duration_ms=10 + i,
                )
            await store.flush()
            async with store._connect() as conn:
                async with conn.execute("SELECT COUNT(*) FROM requests") as cur:
                    row = await cur.fetchone()
            return row[0]

        count = run(go())
        assert count == 5

    def test_flush_empty_queue_is_noop(self) -> None:
        store = make_store()

        async def go():
            await store.flush()  # no rows queued
            async with store._connect() as conn:
                async with conn.execute("SELECT COUNT(*) FROM requests") as cur:
                    row = await cur.fetchone()
            return row[0]

        count = run(go())
        assert count == 0


# ------------------------------------------------------------------ #
# 3. query_summary                                                     #
# ------------------------------------------------------------------ #


class TestQuerySummary:
    def _seed(self, store, rows):
        async def go():
            for r in rows:
                await store.enqueue(**r)
            await store.flush()

        run(go())

    def test_summary_total_requests(self) -> None:
        store = make_store()
        self._seed(
            store,
            [
                dict(
                    timestamp=_ts(i),
                    method="GET",
                    path="/health",
                    status_code=200,
                    duration_ms=i,
                )
                for i in range(7)
            ],
        )
        result = run(store.query_summary())
        assert result["total"] == 7

    def test_summary_status_counts(self) -> None:
        store = make_store()
        self._seed(
            store,
            [
                dict(
                    timestamp=_ts(0),
                    method="GET",
                    path="/health",
                    status_code=200,
                    duration_ms=5,
                ),
                dict(
                    timestamp=_ts(1),
                    method="GET",
                    path="/health",
                    status_code=404,
                    duration_ms=3,
                ),
                dict(
                    timestamp=_ts(2),
                    method="GET",
                    path="/health",
                    status_code=404,
                    duration_ms=2,
                ),
                dict(
                    timestamp=_ts(3),
                    method="GET",
                    path="/health",
                    status_code=500,
                    duration_ms=1,
                ),
            ],
        )
        result = run(store.query_summary())
        assert result["status_counts"]["200"] == 1
        assert result["status_counts"]["404"] == 2
        assert result["status_counts"]["500"] == 1

    def test_summary_with_range_filter(self) -> None:
        """Only rows within `range` are counted."""
        store = make_store()
        # Two rows 2 hours ago (outside 1h range), one row recent
        past = datetime(2026, 4, 10, 10, 0, 0, tzinfo=timezone.utc).isoformat()
        recent = datetime(2026, 4, 10, 11, 50, 0, tzinfo=timezone.utc).isoformat()
        now_str = datetime(2026, 4, 10, 12, 0, 0, tzinfo=timezone.utc).isoformat()

        async def go():
            await store.enqueue(
                timestamp=past, method="GET", path="/h", status_code=200, duration_ms=1
            )
            await store.enqueue(
                timestamp=past, method="GET", path="/h", status_code=200, duration_ms=1
            )
            await store.enqueue(
                timestamp=recent,
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.flush()
            return await store.query_summary(range_preset="1h", now=now_str)

        result = run(go())
        assert result["total"] == 1

    def test_summary_with_status_filter_5xx(self) -> None:
        store = make_store()
        self._seed(
            store,
            [
                dict(
                    timestamp=_ts(0),
                    method="GET",
                    path="/h",
                    status_code=200,
                    duration_ms=1,
                ),
                dict(
                    timestamp=_ts(1),
                    method="GET",
                    path="/h",
                    status_code=500,
                    duration_ms=2,
                ),
                dict(
                    timestamp=_ts(2),
                    method="GET",
                    path="/h",
                    status_code=503,
                    duration_ms=3,
                ),
            ],
        )
        result = run(store.query_summary(status_filter="5xx"))
        assert result["total"] == 2

    def test_summary_with_exact_status_filter(self) -> None:
        store = make_store()
        self._seed(
            store,
            [
                dict(
                    timestamp=_ts(0),
                    method="GET",
                    path="/h",
                    status_code=200,
                    duration_ms=1,
                ),
                dict(
                    timestamp=_ts(1),
                    method="GET",
                    path="/h",
                    status_code=500,
                    duration_ms=2,
                ),
                dict(
                    timestamp=_ts(2),
                    method="GET",
                    path="/h",
                    status_code=503,
                    duration_ms=3,
                ),
            ],
        )
        result = run(store.query_summary(status_filter="500"))
        assert result["total"] == 1
        assert result["status_counts"] == {"500": 1}


# ------------------------------------------------------------------ #
# 4. query_requests                                                    #
# ------------------------------------------------------------------ #


class TestQueryRequests:
    def _seed(self, store, n: int = 5):
        async def go():
            for i in range(n):
                await store.enqueue(
                    timestamp=_ts(i),
                    method="GET",
                    path="/health",
                    status_code=200,
                    duration_ms=i + 1,
                )
            await store.flush()

        run(go())

    def test_returns_most_recent_first(self) -> None:
        store = make_store()
        self._seed(store, 3)
        rows = run(store.query_requests())
        durations = [r["duration_ms"] for r in rows]
        assert durations == sorted(durations, reverse=True)

    def test_limit_respected(self) -> None:
        store = make_store()
        self._seed(store, 10)
        rows = run(store.query_requests(limit=3))
        assert len(rows) == 3

    def test_offset_respected(self) -> None:
        store = make_store()
        self._seed(store, 5)
        all_rows = run(store.query_requests())
        offset_rows = run(store.query_requests(offset=2))
        assert len(offset_rows) == len(all_rows) - 2

    def test_status_filter_4xx(self) -> None:
        store = make_store()

        async def go():
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(1),
                method="GET",
                path="/h",
                status_code=400,
                duration_ms=2,
            )
            await store.enqueue(
                timestamp=_ts(2),
                method="GET",
                path="/h",
                status_code=404,
                duration_ms=3,
            )
            await store.flush()
            return await store.query_requests(status_filter="4xx")

        rows = run(go())
        assert len(rows) == 2
        assert all(400 <= r["status_code"] < 500 for r in rows)

    def test_exact_status_filter(self) -> None:
        store = make_store()

        async def go():
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=400,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(1),
                method="GET",
                path="/h",
                status_code=404,
                duration_ms=2,
            )
            await store.enqueue(
                timestamp=_ts(2),
                method="GET",
                path="/h",
                status_code=404,
                duration_ms=3,
            )
            await store.flush()
            return await store.query_requests(status_filter="404")

        rows = run(go())
        assert len(rows) == 2
        assert all(r["status_code"] == 404 for r in rows)

    def test_row_has_expected_keys(self) -> None:
        store = make_store()

        async def go():
            await store.enqueue(
                timestamp=_ts(),
                method="POST",
                path="/vectorize",
                status_code=200,
                duration_ms=55,
            )
            await store.flush()
            return await store.query_requests()

        rows = run(go())
        assert len(rows) == 1
        assert set(rows[0].keys()) == {
            "timestamp",
            "method",
            "path",
            "status_code",
            "duration_ms",
        }


# ------------------------------------------------------------------ #
# 5. query_timeseries                                                  #
# ------------------------------------------------------------------ #


class TestQueryTimeseries:
    def test_returns_buckets_list(self) -> None:
        store = make_store()

        async def go():
            await store.enqueue(
                timestamp=_ts(), method="GET", path="/h", status_code=200, duration_ms=1
            )
            await store.flush()
            now_str = _ts(60)
            return await store.query_timeseries(range_preset="5m", now=now_str)

        result = run(go())
        assert "buckets" in result
        assert "range" in result
        assert "bucket_width" in result
        assert "total" in result

    def test_bucket_aggregates_counts(self) -> None:
        store = make_store()
        # 3 requests at t=0, 2 at t=30s — use 5m window so both are included
        now_str = _ts(90)

        async def go():
            for _ in range(3):
                await store.enqueue(
                    timestamp=_ts(0),
                    method="GET",
                    path="/h",
                    status_code=200,
                    duration_ms=1,
                )
            for _ in range(2):
                await store.enqueue(
                    timestamp=_ts(30),
                    method="GET",
                    path="/h",
                    status_code=200,
                    duration_ms=1,
                )
            await store.flush()
            return await store.query_timeseries(range_preset="5m", now=now_str)

        result = run(go())
        total = sum(b["count"] for b in result["buckets"])
        assert total == 5

    def test_status_filter_applied_to_timeseries(self) -> None:
        store = make_store()
        # Use 5m range so all rows at t=0,10,20 are within the window from now=t=90
        now_str = _ts(90)

        async def go():
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(10),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(20),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=1,
            )
            await store.flush()
            return await store.query_timeseries(
                range_preset="5m", status_filter="5xx", now=now_str
            )

        result = run(go())
        total = sum(b["count"] for b in result["buckets"])
        assert total == 2

    def test_exact_status_filter_applied_to_timeseries(self) -> None:
        store = make_store()
        now_str = _ts(90)

        async def go():
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(10),
                method="GET",
                path="/h",
                status_code=503,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(20),
                method="GET",
                path="/h",
                status_code=503,
                duration_ms=1,
            )
            await store.flush()
            return await store.query_timeseries(
                range_preset="5m", status_filter="503", now=now_str
            )

        result = run(go())
        total = sum(b["count"] for b in result["buckets"])
        assert total == 2
        bucket = result["buckets"][0]
        assert bucket["status_counts"] == {"503": 2}

    def test_invalid_range_raises(self) -> None:
        store = make_store()
        with pytest.raises(ValueError, match="Invalid range_preset"):
            run(store.query_timeseries(range_preset="99y"))

    def test_buckets_include_status_breakdown(self) -> None:
        """Each bucket must include count_2xx, count_3xx, count_4xx, count_5xx."""
        store = make_store()
        now_str = _ts(90)

        async def go():
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=404,
                duration_ms=2,
            )
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=3,
            )
            await store.flush()
            return await store.query_timeseries(range_preset="5m", now=now_str)

        result = run(go())
        assert len(result["buckets"]) == 1
        bucket = result["buckets"][0]
        assert bucket["status_counts"] == {"200": 1, "404": 1, "500": 1}
        assert bucket["count_2xx"] == 1
        assert bucket["count_3xx"] == 0
        assert bucket["count_4xx"] == 1
        assert bucket["count_5xx"] == 1
        assert bucket["count"] == 3

    def test_status_breakdown_across_multiple_buckets(self) -> None:
        """Status breakdown should be accurate per bucket across different timestamps."""
        store = make_store()
        now_str = _ts(120)

        async def go():
            # Bucket 1 (t=0) → minute "2026-04-10T12:00"
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            # Bucket 2 (t=60) → minute "2026-04-10T12:01"
            await store.enqueue(
                timestamp=_ts(60),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=1,
            )
            await store.enqueue(
                timestamp=_ts(60),
                method="GET",
                path="/h",
                status_code=301,
                duration_ms=1,
            )
            await store.flush()
            return await store.query_timeseries(range_preset="5m", now=now_str)

        result = run(go())
        assert len(result["buckets"]) == 2

        b0 = result["buckets"][0]  # "2026-04-10T12:00"
        assert b0["status_counts"] == {"200": 2}
        assert b0["count_2xx"] == 2
        assert b0["count_5xx"] == 0

        b1 = result["buckets"][1]  # "2026-04-10T12:01"
        assert b1["status_counts"] == {"301": 1, "500": 1}
        assert b1["count_3xx"] == 1
        assert b1["count_5xx"] == 1
        assert b1["count_2xx"] == 0

    def test_custom_range_from_to_filters_timeseries(self) -> None:
        """query_timeseries with from_ts/to_ts returns only rows within that window."""
        store = make_store()
        now_str = _ts(300)

        async def go():
            # Row at t=0 (12:00:00)
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            # Row at t=60 (12:01:00)
            await store.enqueue(
                timestamp=_ts(60),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            # Row at t=120 (12:02:00)
            await store.enqueue(
                timestamp=_ts(120),
                method="GET",
                path="/h",
                status_code=404,
                duration_ms=1,
            )
            # Row at t=180 (12:03:00)
            await store.enqueue(
                timestamp=_ts(180),
                method="GET",
                path="/h",
                status_code=500,
                duration_ms=1,
            )
            await store.flush()
            # Only rows between t=50 and t=130 should be included (t=60 and t=120)
            return await store.query_timeseries(
                range_preset="5m",
                from_ts=_ts(50),
                to_ts=_ts(130),
                now=now_str,
            )

        result = run(go())
        assert result["total"] == 2

    def test_custom_range_from_to_overrides_preset_window(self) -> None:
        """from_ts/to_ts override the range_preset time window."""
        store = make_store()
        now_str = _ts(7200)  # 2 hours later

        async def go():
            # Row at t=0 (inside from_ts/to_ts but outside 5m from now)
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.flush()
            # 5m preset from now_str=t+7200 would miss t=0,
            # but from_ts/to_ts explicitly includes it
            return await store.query_timeseries(
                range_preset="5m",
                from_ts=_ts(-10),
                to_ts=_ts(10),
                now=now_str,
            )

        result = run(go())
        assert result["total"] == 1

    def test_persistence_survives_restart_with_file_db(self, tmp_path) -> None:
        db_path = tmp_path / "obs.db"

        async def seed_then_close() -> None:
            store = ObsStore(db_path=str(db_path))
            await store.init_db()
            await store.enqueue(
                timestamp=_ts(0),
                method="GET",
                path="/health",
                status_code=200,
                duration_ms=5,
            )
            await store.flush()
            await store.close()

        async def reopen_and_read() -> dict[str, object]:
            store = ObsStore(db_path=str(db_path))
            await store.init_db()
            rows = await store.query_requests()
            summary = await store.query_summary()
            await store.close()
            return {"rows": rows, "summary": summary}

        run(seed_then_close())
        result = run(reopen_and_read())
        rows = result["rows"]
        summary = result["summary"]
        assert len(rows) == 1
        assert rows[0]["path"] == "/health"
        assert summary["total"] == 1


# ------------------------------------------------------------------ #
# 6. prune                                                             #
# ------------------------------------------------------------------ #


class TestPrune:
    def test_prune_removes_old_rows(self) -> None:
        store = make_store()
        old = datetime(2020, 1, 1, 0, 0, 0, tzinfo=timezone.utc).isoformat()
        recent = _ts()

        async def go():
            await store.enqueue(
                timestamp=old, method="GET", path="/h", status_code=200, duration_ms=1
            )
            await store.enqueue(
                timestamp=recent,
                method="GET",
                path="/h",
                status_code=200,
                duration_ms=1,
            )
            await store.flush()
            await store.prune(retention_days=30)
            async with store._connect() as conn:
                async with conn.execute("SELECT COUNT(*) FROM requests") as cur:
                    row = await cur.fetchone()
            return row[0]

        count = run(go())
        assert count == 1

    def test_prune_keeps_rows_within_retention(self) -> None:
        store = make_store()
        recent = _ts()

        async def go():
            for _ in range(5):
                await store.enqueue(
                    timestamp=recent,
                    method="GET",
                    path="/h",
                    status_code=200,
                    duration_ms=1,
                )
            await store.flush()
            await store.prune(retention_days=30)
            async with store._connect() as conn:
                async with conn.execute("SELECT COUNT(*) FROM requests") as cur:
                    row = await cur.fetchone()
            return row[0]

        count = run(go())
        assert count == 5
