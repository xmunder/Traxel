from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from src.main import create_app


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #


def basic_auth_header(username: str, password: str) -> str:
    raw = f"{username}:{password}".encode()
    return f"Basic {base64.b64encode(raw).decode()}"


@contextmanager
def obs_client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    username: str = "",
    secret: str = "",
    db_path: str = "",
):
    """Context manager that yields a TestClient whose lifespan has been started.

    This ensures ``app.state.metrics_collector`` is available for every test
    and that ``get_settings`` reflects the patched env vars.

    ``db_path=""`` disables SQLite persistence (legacy in-memory mode).
    ``db_path=":memory:"`` enables SQLite persistence with an in-memory DB.
    """
    monkeypatch.setenv("OBS_USERNAME", username)
    monkeypatch.setenv("OBS_SECRET", secret)
    monkeypatch.setenv("OBS_DB_PATH", db_path)

    from src.config import get_settings

    get_settings.cache_clear()

    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client

    # Clear the LRU cache after the test so the next test starts fresh.
    get_settings.cache_clear()


def _seed_requests_via_store(client, rows: list[dict]) -> None:
    """Insert rows directly into obs_store and flush synchronously."""
    obs_store = getattr(client.app.state, "obs_store", None)
    if obs_store is None:
        raise RuntimeError("obs_store not available — use db_path=':memory:'")

    async def _go():
        for row in rows:
            await obs_store.enqueue(**row)
        await obs_store.flush()

    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    loop.run_until_complete(_go())


# ------------------------------------------------------------------ #
# 503 when credentials are not configured                              #
# ------------------------------------------------------------------ #


class TestObsDisabledWhenUnconfigured:
    def test_summary_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503

    def test_requests_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503

    def test_errors_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503


# ------------------------------------------------------------------ #
# 401 on wrong credentials                                             #
# ------------------------------------------------------------------ #


class TestObsAuthGuard:
    def test_summary_returns_401_on_wrong_password(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(
            monkeypatch, username="admin", secret="correctpassword"
        ) as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "wrongpassword")},
            )
        assert response.status_code == 401

    def test_summary_returns_401_on_wrong_username(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(
            monkeypatch, username="admin", secret="correctpassword"
        ) as client:
            response = client.get(
                "/obs/summary",
                headers={
                    "Authorization": basic_auth_header("wronguser", "correctpassword")
                },
            )
        assert response.status_code == 401

    def test_requests_returns_401_on_wrong_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("admin", "bad")},
            )
        assert response.status_code == 401

    def test_errors_returns_401_on_wrong_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("admin", "bad")},
            )
        assert response.status_code == 401

    def test_summary_returns_401_when_no_auth_header(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get("/obs/summary")
        assert response.status_code == 401


# ------------------------------------------------------------------ #
# Success cases with valid credentials                                 #
# ------------------------------------------------------------------ #


class TestObsSuccess:
    def test_summary_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "total_requests" in data
        assert "total_errors" in data
        assert "status_counts" in data
        assert "path_counts" in data
        assert "requests_buffer_size" in data
        assert "errors_buffer_size" in data

    def test_requests_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data

    def test_errors_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data

    def test_summary_counts_recorded_after_health_request(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Trigger a /health request that the middleware should record
            client.get("/health")
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total_requests"] >= 1

    def test_summary_status_counts_have_string_keys(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """JSON object keys must always be strings (HTTP status codes as str)."""
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        status_counts = response.json()["status_counts"]
        for key in status_counts:
            assert isinstance(key, str), f"Expected string key, got {type(key)}: {key}"


# ------------------------------------------------------------------ #
# /obs/* exclusion from metrics collection                             #
# ------------------------------------------------------------------ #


class TestObsExcludedFromMetrics:
    def test_obs_requests_not_counted_in_total_requests(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Accessing /obs/* must not inflate total_requests counter."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Access summary multiple times
            for _ in range(3):
                client.get("/obs/summary", headers={"Authorization": auth})

            final = client.get("/obs/summary", headers={"Authorization": auth})
        assert final.status_code == 200
        data = final.json()
        # total_requests should still be 0 since only /obs/* were called
        assert data["total_requests"] == 0

    def test_non_obs_requests_are_counted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            client.get("/health")
            final = client.get("/obs/summary", headers={"Authorization": auth})
        data = final.json()
        assert data["total_requests"] >= 2


# ------------------------------------------------------------------ #
# Payload contracts                                                    #
# ------------------------------------------------------------------ #


class TestObsPayloadContracts:
    def test_requests_item_has_required_fields(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            response = client.get("/obs/requests", headers={"Authorization": auth})
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        item = data["items"][0]
        assert set(item.keys()) == {
            "timestamp",
            "method",
            "path",
            "status_code",
            "duration_ms",
            "message",
        }

    def test_errors_item_has_required_fields_after_injection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Verify schema by recording an error manually via the collector."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Inject an error record directly into the collector via app state
            collector = client.app.state.metrics_collector
            collector.record_error(
                method="POST",
                path="/vectorize",
                error_type="TestError",
                error_detail="injected for test",
            )
            response = client.get("/obs/errors", headers={"Authorization": auth})
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        item = data["items"][0]
        assert set(item.keys()) == {
            "timestamp",
            "method",
            "path",
            "error_type",
            "error_detail",
        }


# ------------------------------------------------------------------ #
# Task 2.2: /obs/summary and /obs/requests query params               #
# ------------------------------------------------------------------ #


class TestObsSummaryQueryParams:
    """Summary endpoint must accept range and status query parameters."""

    def test_summary_accepts_range_param(self, monkeypatch: pytest.MonkeyPatch) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/summary?range=1h",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_summary_accepts_status_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/summary?status=5xx",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_summary_accepts_exact_status_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/summary?status=500",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_summary_with_sqlite_returns_persisted_total(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When SQLite is active, persisted_total is populated in the response."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/health",
                        status_code=200,
                        duration_ms=5,
                    )
                ],
            )
            response = client.get(
                "/obs/summary",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["persisted_total"] is not None
        assert data["persisted_total"] >= 1

    def test_summary_status_filter_limits_persisted_total(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """status=5xx must only count 5xx rows in persisted_total."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=1,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=500,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=503,
                        duration_ms=3,
                    ),
                ],
            )
            response = client.get(
                "/obs/summary?status=5xx",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["persisted_total"] == 2

    def test_summary_exact_status_filter_limits_persisted_total(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=500,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=503,
                        duration_ms=3,
                    ),
                ],
            )
            response = client.get(
                "/obs/summary?status=503",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["persisted_total"] == 1
        assert data["status_counts"] == {"503": 1}


class TestObsRequestsQueryParams:
    """Requests endpoint must accept range, status, limit, offset params."""

    def test_requests_accepts_limit_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/requests?limit=5",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_requests_accepts_offset_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/requests?offset=0",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_requests_with_sqlite_uses_store(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When SQLite is active, /obs/requests uses the ObsStore."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="POST",
                        path="/vectorize",
                        status_code=200,
                        duration_ms=42,
                    )
                ],
            )
            response = client.get(
                "/obs/requests",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        item = data["items"][0]
        assert item["path"] == "/vectorize"
        assert item["status_code"] == 200
        assert item["message"] == "OK"

    def test_requests_status_filter_with_sqlite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """status=4xx must return only 4xx rows when using SQLite."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=1,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=404,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=403,
                        duration_ms=3,
                    ),
                ],
            )
            response = client.get(
                "/obs/requests?status=4xx",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2
        assert all(400 <= item["status_code"] < 500 for item in data["items"])

    def test_requests_exact_status_filter_with_sqlite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=400,
                        duration_ms=1,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=404,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=404,
                        duration_ms=3,
                    ),
                ],
            )
            response = client.get(
                "/obs/requests?status=404",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2
        assert all(item["status_code"] == 404 for item in data["items"])


class TestObsErrorsQueryParams:
    """Errors endpoint must accept limit query parameter."""

    def test_errors_accepts_limit_param(self, monkeypatch: pytest.MonkeyPatch) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            collector = client.app.state.metrics_collector
            for i in range(5):
                collector.record_error(
                    method="POST",
                    path="/vectorize",
                    error_type="TestError",
                    error_detail=f"error {i}",
                )
            response = client.get(
                "/obs/errors?limit=2",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 2

    def test_errors_limit_defaults_to_all_available(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without explicit limit, errors should return up to the configured max."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            collector = client.app.state.metrics_collector
            for i in range(3):
                collector.record_error(
                    method="POST",
                    path="/vectorize",
                    error_type="TestError",
                    error_detail=f"error {i}",
                )
            response = client.get(
                "/obs/errors",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3


# ------------------------------------------------------------------ #
# Task 2.3: GET /obs/timeseries                                        #
# ------------------------------------------------------------------ #


class TestObsTimeseries:
    """Timeseries endpoint returns bucketed counts."""

    def test_timeseries_returns_401_without_auth(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get("/obs/timeseries")
        assert response.status_code == 401

    def test_timeseries_returns_503_without_sqlite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without SQLite, timeseries endpoint returns 503."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/timeseries",
                headers={"Authorization": auth},
            )
        assert response.status_code == 503

    def test_timeseries_returns_200_with_sqlite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert "buckets" in data
        assert "range" in data
        assert "bucket_width" in data
        assert "total" in data

    def test_timeseries_default_range_is_12h(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        assert response.json()["range"] == "12h"

    def test_timeseries_accepts_range_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries?range=1h",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        assert response.json()["range"] == "1h"

    def test_timeseries_accepts_status_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries?status=5xx",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_timeseries_accepts_exact_status_param(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries?status=500",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200

    def test_timeseries_returns_400_on_invalid_range(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries?range=99y",
                headers={"Authorization": auth},
            )
        assert response.status_code == 400

    def test_timeseries_bucket_width_matches_range(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """bucket_width for 30m range must be '5m' per BUCKET_MAP."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            response = client.get(
                "/obs/timeseries?range=30m",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        assert response.json()["bucket_width"] == "5m"

    def test_timeseries_accepts_from_to_params(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Timeseries endpoint accepts from_ts and to_ts query params."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/health",
                        status_code=200,
                        duration_ms=5,
                    )
                ],
            )
            response = client.get(
                f"/obs/timeseries?range=1h&from_ts={ts}&to_ts={ts}",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert "buckets" in data

    def test_timeseries_from_to_filters_data(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """from_ts/to_ts narrow the timeseries to the specified window."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            from datetime import timedelta

            now = datetime.now(tz=timezone.utc)
            t_early = (now - timedelta(minutes=10)).isoformat()
            t_mid = (now - timedelta(minutes=5)).isoformat()
            t_late = now.isoformat()

            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=t_early,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=1,
                    ),
                    dict(
                        timestamp=t_mid,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=t_late,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=3,
                    ),
                ],
            )
            # Only include the middle row
            from_ts = (now - timedelta(minutes=6)).isoformat()
            to_ts = (now - timedelta(minutes=4)).isoformat()
            response = client.get(
                f"/obs/timeseries?range=30m&from_ts={from_ts}&to_ts={to_ts}",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1

    def test_timeseries_seeded_data_appears_in_buckets(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Rows persisted to SQLite appear in timeseries buckets."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/health",
                        status_code=200,
                        duration_ms=5,
                    )
                    for _ in range(3)
                ],
            )
            response = client.get(
                "/obs/timeseries?range=5m",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3

    def test_timeseries_buckets_include_status_breakdown(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Each timeseries bucket must include exact and family status breakdown fields."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(
            monkeypatch, username="admin", secret="s3cr3t", db_path=":memory:"
        ) as client:
            ts = datetime.now(tz=timezone.utc).isoformat()
            _seed_requests_via_store(
                client,
                [
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=200,
                        duration_ms=1,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=404,
                        duration_ms=2,
                    ),
                    dict(
                        timestamp=ts,
                        method="GET",
                        path="/h",
                        status_code=500,
                        duration_ms=3,
                    ),
                ],
            )
            response = client.get(
                "/obs/timeseries?range=5m",
                headers={"Authorization": auth},
            )
        assert response.status_code == 200
        data = response.json()
        assert len(data["buckets"]) >= 1
        bucket = data["buckets"][0]
        assert bucket["status_counts"] == {"200": 1, "404": 1, "500": 1}
        assert "count_2xx" in bucket
        assert "count_4xx" in bucket
        assert "count_5xx" in bucket
        assert bucket["count_2xx"] == 1
        assert bucket["count_4xx"] == 1
        assert bucket["count_5xx"] == 1


# ------------------------------------------------------------------ #
# 503 when credentials are not configured                              #
# ------------------------------------------------------------------ #


class TestObsDisabledWhenUnconfigured:
    def test_summary_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503

    def test_requests_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503

    def test_errors_returns_503_when_no_creds_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="", secret="") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("any", "any")},
            )
        assert response.status_code == 503


# ------------------------------------------------------------------ #
# 401 on wrong credentials                                             #
# ------------------------------------------------------------------ #


class TestObsAuthGuard:
    def test_summary_returns_401_on_wrong_password(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(
            monkeypatch, username="admin", secret="correctpassword"
        ) as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "wrongpassword")},
            )
        assert response.status_code == 401

    def test_summary_returns_401_on_wrong_username(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(
            monkeypatch, username="admin", secret="correctpassword"
        ) as client:
            response = client.get(
                "/obs/summary",
                headers={
                    "Authorization": basic_auth_header("wronguser", "correctpassword")
                },
            )
        assert response.status_code == 401

    def test_requests_returns_401_on_wrong_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("admin", "bad")},
            )
        assert response.status_code == 401

    def test_errors_returns_401_on_wrong_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("admin", "bad")},
            )
        assert response.status_code == 401

    def test_summary_returns_401_when_no_auth_header(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="secret") as client:
            response = client.get("/obs/summary")
        assert response.status_code == 401


# ------------------------------------------------------------------ #
# Success cases with valid credentials                                 #
# ------------------------------------------------------------------ #


class TestObsSuccess:
    def test_summary_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "total_requests" in data
        assert "total_errors" in data
        assert "status_counts" in data
        assert "path_counts" in data
        assert "requests_buffer_size" in data
        assert "errors_buffer_size" in data

    def test_requests_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/requests",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data

    def test_errors_returns_200_with_valid_creds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            response = client.get(
                "/obs/errors",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data

    def test_summary_counts_recorded_after_health_request(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Trigger a /health request that the middleware should record
            client.get("/health")
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["total_requests"] >= 1

    def test_summary_status_counts_have_string_keys(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """JSON object keys must always be strings (HTTP status codes as str)."""
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            response = client.get(
                "/obs/summary",
                headers={"Authorization": basic_auth_header("admin", "s3cr3t")},
            )
        assert response.status_code == 200
        status_counts = response.json()["status_counts"]
        for key in status_counts:
            assert isinstance(key, str), f"Expected string key, got {type(key)}: {key}"


# ------------------------------------------------------------------ #
# /obs/* exclusion from metrics collection                             #
# ------------------------------------------------------------------ #


class TestObsExcludedFromMetrics:
    def test_obs_requests_not_counted_in_total_requests(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Accessing /obs/* must not inflate total_requests counter."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Access summary multiple times
            for _ in range(3):
                client.get("/obs/summary", headers={"Authorization": auth})

            final = client.get("/obs/summary", headers={"Authorization": auth})
        assert final.status_code == 200
        data = final.json()
        # total_requests should still be 0 since only /obs/* were called
        assert data["total_requests"] == 0

    def test_non_obs_requests_are_counted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            client.get("/health")
            final = client.get("/obs/summary", headers={"Authorization": auth})
        data = final.json()
        assert data["total_requests"] >= 2


# ------------------------------------------------------------------ #
# Payload contracts                                                    #
# ------------------------------------------------------------------ #


class TestObsPayloadContracts:
    def test_requests_item_has_required_fields(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            client.get("/health")
            response = client.get("/obs/requests", headers={"Authorization": auth})
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        item = data["items"][0]
        assert set(item.keys()) == {
            "timestamp",
            "method",
            "path",
            "status_code",
            "duration_ms",
            "message",
        }

    def test_errors_item_has_required_fields_after_injection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Verify schema by recording an error manually via the collector."""
        auth = basic_auth_header("admin", "s3cr3t")
        with obs_client(monkeypatch, username="admin", secret="s3cr3t") as client:
            # Inject an error record directly into the collector via app state
            collector = client.app.state.metrics_collector
            collector.record_error(
                method="POST",
                path="/vectorize",
                error_type="TestError",
                error_detail="injected for test",
            )
            response = client.get("/obs/errors", headers={"Authorization": auth})
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 1
        item = data["items"][0]
        assert set(item.keys()) == {
            "timestamp",
            "method",
            "path",
            "error_type",
            "error_detail",
        }
