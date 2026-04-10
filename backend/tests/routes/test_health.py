from __future__ import annotations

from fastapi.testclient import TestClient


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
