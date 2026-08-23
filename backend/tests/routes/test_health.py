from __future__ import annotations

from fastapi.testclient import TestClient

import pytest

from src.main import create_app



def test_get_health_returns_operational_payload(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "vectorizer-backend",
        "version": "0.1.0",
    }


def test_get_health_includes_observability_headers(client: TestClient) -> None:
    response = client.get("/health", headers={"X-Request-ID": "health-req-1"})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "health-req-1"
    assert int(response.headers["X-Process-Time-MS"]) >= 0


def test_get_health_includes_security_headers(client: TestClient) -> None:
    response = client.get("/health")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Permissions-Policy"] == "camera=(), geolocation=(), microphone=()"


def test_production_disables_api_documentation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "production")
    from src.config import get_settings

    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as production_client:
            assert production_client.get("/docs").status_code == 404
            assert production_client.get("/redoc").status_code == 404
            assert production_client.get("/openapi.json").status_code == 404
    finally:
        get_settings.cache_clear()


def test_production_cors_does_not_allow_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "production")
    from src.config import get_settings

    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as production_client:
            response = production_client.options(
                "/vectorize",
                headers={
                    "Origin": "http://localhost:4321",
                    "Access-Control-Request-Method": "POST",
                },
            )

        assert "access-control-allow-origin" not in response.headers
    finally:
        get_settings.cache_clear()
