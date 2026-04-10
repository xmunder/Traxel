from __future__ import annotations

import threading
from time import sleep

import pytest

from src.utils.metrics_collector import MetricsCollector


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #


def make_collector(**kwargs) -> MetricsCollector:
    return MetricsCollector(
        requests_limit=kwargs.get("requests_limit", 5),
        errors_limit=kwargs.get("errors_limit", 3),
        path_label_limit=kwargs.get("path_label_limit", 10),
    )


# ------------------------------------------------------------------ #
# Ring-buffer eviction (deque maxlen)                                  #
# ------------------------------------------------------------------ #


class TestRingBufferEviction:
    def test_requests_buffer_bounded_by_limit(self) -> None:
        collector = make_collector(requests_limit=3)
        for i in range(10):
            collector.record_request(
                method="GET",
                path="/vectorize",
                status_code=200,
                duration_ms=i,
            )
        snapshot = collector.snapshot_summary()
        assert snapshot["requests_buffer_size"] == 3

    def test_errors_buffer_bounded_by_limit(self) -> None:
        collector = make_collector(errors_limit=2)
        for i in range(6):
            collector.record_error(
                method="POST",
                path="/vectorize",
                error_type="ValueError",
                error_detail=f"error {i}",
            )
        snapshot = collector.snapshot_summary()
        assert snapshot["errors_buffer_size"] == 2

    def test_requests_snapshot_returns_most_recent_first(self) -> None:
        collector = make_collector(requests_limit=5)
        for i in range(3):
            collector.record_request(
                method="GET",
                path="/health",
                status_code=200,
                duration_ms=i,
            )
        rows = collector.snapshot_requests()
        durations = [r["duration_ms"] for r in rows]
        assert durations == [2, 1, 0]

    def test_errors_snapshot_returns_most_recent_first(self) -> None:
        collector = make_collector(errors_limit=5)
        for i in range(3):
            collector.record_error(
                method="POST",
                path="/vectorize",
                error_type="RuntimeError",
                error_detail=f"detail {i}",
            )
        rows = collector.snapshot_errors()
        details = [r["error_detail"] for r in rows]
        assert details == ["detail 2", "detail 1", "detail 0"]

    def test_oldest_request_evicted_when_buffer_full(self) -> None:
        collector = make_collector(requests_limit=3)
        for i in range(4):
            collector.record_request(
                method="GET",
                path="/vectorize",
                status_code=200,
                duration_ms=i,
            )
        rows = collector.snapshot_requests()
        durations = [r["duration_ms"] for r in rows]
        # Evicted: duration_ms=0; remaining: 3,2,1
        assert 0 not in durations
        assert len(rows) == 3


# ------------------------------------------------------------------ #
# Counters                                                             #
# ------------------------------------------------------------------ #


class TestCounters:
    def test_total_requests_increments(self) -> None:
        collector = make_collector(requests_limit=50)
        for _ in range(5):
            collector.record_request(
                method="GET", path="/health", status_code=200, duration_ms=10
            )
        assert collector.snapshot_summary()["total_requests"] == 5

    def test_total_errors_increments(self) -> None:
        collector = make_collector(errors_limit=10)
        for _ in range(3):
            collector.record_error(
                method="POST",
                path="/vectorize",
                error_type="IOError",
                error_detail="disk failure",
            )
        assert collector.snapshot_summary()["total_errors"] == 3

    def test_status_counts_aggregated(self) -> None:
        collector = make_collector(requests_limit=20)
        collector.record_request(
            method="GET", path="/health", status_code=200, duration_ms=5
        )
        collector.record_request(
            method="POST", path="/vectorize", status_code=400, duration_ms=12
        )
        collector.record_request(
            method="GET", path="/health", status_code=200, duration_ms=3
        )
        counts = collector.snapshot_summary()["status_counts"]
        assert counts[200] == 2
        assert counts[400] == 1

    def test_path_counts_whitelisted_paths_counted_by_label(self) -> None:
        collector = make_collector(requests_limit=20)
        collector.record_request(
            method="GET", path="/vectorize", status_code=200, duration_ms=8
        )
        collector.record_request(
            method="GET", path="/health", status_code=200, duration_ms=4
        )
        counts = collector.snapshot_summary()["path_counts"]
        assert counts["/vectorize"] == 1
        assert counts["/health"] == 1

    def test_unknown_paths_aggregated_to_other(self) -> None:
        collector = make_collector(requests_limit=20)
        for path in ("/unknown", "/api/v1/foo", "/admin"):
            collector.record_request(
                method="GET", path=path, status_code=404, duration_ms=2
            )
        counts = collector.snapshot_summary()["path_counts"]
        assert counts.get("other", 0) == 3
        # Should not have individual unknown path entries
        assert "/unknown" not in counts
        assert "/api/v1/foo" not in counts


# ------------------------------------------------------------------ #
# Path whitelist aggregation                                           #
# ------------------------------------------------------------------ #


class TestPathWhitelist:
    def test_obs_paths_excluded_from_collector(self) -> None:
        """The middleware excludes /obs/* — verify by recording a non-obs path."""
        collector = make_collector(requests_limit=20)
        # obs paths should NOT be recorded by middleware (not tested here directly)
        # but we validate the whitelisting works for normal paths
        collector.record_request(
            method="GET", path="/health", status_code=200, duration_ms=5
        )
        counts = collector.snapshot_summary()["path_counts"]
        assert "/health" in counts

    def test_arbitrary_paths_do_not_create_new_keys(self) -> None:
        collector = make_collector(requests_limit=50)
        for i in range(20):
            collector.record_request(
                method="GET",
                path=f"/unique-path-{i}",
                status_code=404,
                duration_ms=1,
            )
        counts = collector.snapshot_summary()["path_counts"]
        # All 20 unique unknown paths collapse into "other"
        assert len(counts) == 1
        assert counts["other"] == 20


# ------------------------------------------------------------------ #
# Thread-safe snapshots                                                #
# ------------------------------------------------------------------ #


class TestThreadSafety:
    def test_concurrent_writes_do_not_corrupt_total(self) -> None:
        collector = make_collector(requests_limit=1000)
        total_writes = 200
        threads_count = 10
        writes_per_thread = total_writes // threads_count

        def write_requests() -> None:
            for _ in range(writes_per_thread):
                collector.record_request(
                    method="GET",
                    path="/health",
                    status_code=200,
                    duration_ms=1,
                )

        threads = [
            threading.Thread(target=write_requests) for _ in range(threads_count)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert collector.snapshot_summary()["total_requests"] == total_writes

    def test_snapshot_while_writing_does_not_raise(self) -> None:
        collector = make_collector(requests_limit=500)
        errors: list[Exception] = []

        def write() -> None:
            for i in range(100):
                collector.record_request(
                    method="POST",
                    path="/vectorize",
                    status_code=200,
                    duration_ms=i,
                )

        def read() -> None:
            for _ in range(50):
                try:
                    collector.snapshot_requests()
                    collector.snapshot_summary()
                except Exception as exc:
                    errors.append(exc)

        writers = [threading.Thread(target=write) for _ in range(5)]
        readers = [threading.Thread(target=read) for _ in range(5)]

        for t in writers + readers:
            t.start()
        for t in writers + readers:
            t.join()

        assert not errors, f"Thread-safety errors: {errors}"


# ------------------------------------------------------------------ #
# Snapshot helpers contract                                            #
# ------------------------------------------------------------------ #


class TestSnapshotContract:
    def test_snapshot_summary_returns_expected_keys(self) -> None:
        collector = make_collector()
        summary = collector.snapshot_summary()
        expected_keys = {
            "total_requests",
            "total_errors",
            "status_counts",
            "path_counts",
            "requests_buffer_size",
            "errors_buffer_size",
        }
        assert set(summary.keys()) == expected_keys

    def test_request_record_dict_has_expected_keys(self) -> None:
        collector = make_collector(requests_limit=5)
        collector.record_request(
            method="GET", path="/health", status_code=200, duration_ms=7
        )
        rows = collector.snapshot_requests()
        assert len(rows) == 1
        assert set(rows[0].keys()) == {
            "timestamp",
            "method",
            "path",
            "status_code",
            "duration_ms",
        }

    def test_error_record_dict_has_expected_keys(self) -> None:
        collector = make_collector(errors_limit=5)
        collector.record_error(
            method="POST",
            path="/vectorize",
            error_type="RuntimeError",
            error_detail="boom",
        )
        rows = collector.snapshot_errors()
        assert len(rows) == 1
        assert set(rows[0].keys()) == {
            "timestamp",
            "method",
            "path",
            "error_type",
            "error_detail",
        }

    def test_snapshot_limit_parameter_respected(self) -> None:
        collector = make_collector(requests_limit=10)
        for _ in range(10):
            collector.record_request(
                method="GET", path="/health", status_code=200, duration_ms=1
            )
        rows = collector.snapshot_requests(limit=3)
        assert len(rows) == 3
