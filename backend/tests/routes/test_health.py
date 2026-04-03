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


def test_get_health_records_request_metrics(client: TestClient) -> None:
    calls: list[dict[str, object]] = []

    class Recorder:
        def record_request(self, **kwargs) -> None:
            calls.append(kwargs)

    client.app.state.request_metrics = Recorder()

    response = client.get("/health")

    assert response.status_code == 200
    assert calls == [
        {
            "method": "GET",
            "path": "/health",
            "status_code": 200,
            "duration_ms": calls[0]["duration_ms"],
        }
    ]
    assert isinstance(calls[0]["duration_ms"], float)
    assert calls[0]["duration_ms"] >= 0
