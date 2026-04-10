from __future__ import annotations

import base64
from contextlib import contextmanager

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
    monkeypatch: pytest.MonkeyPatch, *, username: str = "", secret: str = ""
):
    """Context manager that yields a TestClient whose lifespan has been started.

    This ensures ``app.state.metrics_collector`` is available for every test
    and that ``get_settings`` reflects the patched env vars.
    """
    monkeypatch.setenv("OBS_USERNAME", username)
    monkeypatch.setenv("OBS_SECRET", secret)

    from src.config import get_settings

    get_settings.cache_clear()

    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client

    # Clear the LRU cache after the test so the next test starts fresh.
    get_settings.cache_clear()


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
