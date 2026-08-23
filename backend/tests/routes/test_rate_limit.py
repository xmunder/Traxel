from __future__ import annotations

from fastapi.testclient import TestClient

from src.main import create_app
from src.utils.rate_limit import RateLimiter


def test_login_rate_limit_returns_429_after_five_attempts(monkeypatch) -> None:
    monkeypatch.setenv("OBS_USERNAME", "admin")
    monkeypatch.setenv("OBS_SECRET", "correct-secret")

    from src.config import get_settings

    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            responses = [
                client.post(
                    "/obs/login",
                    json={"username": "admin", "password": "wrong-secret"},
                    headers={"Origin": "http://localhost:4411"},
                )
                for _ in range(6)
            ]

        assert [response.status_code for response in responses] == [
            401,
            401,
            401,
            401,
            401,
            429,
        ]
        assert responses[-1].headers["Retry-After"] == "60"
    finally:
        get_settings.cache_clear()


def test_vectorize_rate_limit_returns_429_after_configured_limit(monkeypatch) -> None:
    monkeypatch.setenv("VECTORIZE_RATE_LIMIT", "1")

    from src.config import get_settings

    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            first = client.post(
                "/vectorize", files={"other": ("empty.txt", b"", "text/plain")}
            )
            second = client.post(
                "/vectorize", files={"other": ("empty.txt", b"", "text/plain")}
            )

        assert first.status_code == 400
        assert second.status_code == 429
    finally:
        get_settings.cache_clear()


def test_rate_limiter_evicts_oldest_keys_at_capacity() -> None:
    limiter = RateLimiter(max_keys=2)

    assert limiter.allow("ip-a", "vectorize", 1, 60) is True
    assert limiter.allow("ip-b", "vectorize", 1, 60) is True
    assert limiter.allow("ip-c", "vectorize", 1, 60) is True

    assert len(limiter._requests) == 2
    assert ("vectorize", "ip-a") not in limiter._requests
