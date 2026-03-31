from __future__ import annotations

from fastapi.testclient import TestClient

from src import routes as routes_package


def test_post_vectorize_returns_placeholder_svg_for_valid_image(
    client: TestClient,
    image_bytes_factory,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["svg"].startswith("<svg")
    assert payload["metadata"] == {
        "colors_detected": 0,
        "paths_generated": 0,
        "duration_ms": payload["metadata"]["duration_ms"],
    }
    assert payload["metadata"]["duration_ms"] >= 0


def test_post_vectorize_returns_clear_error_when_image_is_missing(
    client: TestClient,
) -> None:
    response = client.post(
        "/vectorize", files={"other": ("note.txt", b"hello", "text/plain")}
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "The 'image' field is required."}


def test_post_vectorize_returns_clear_error_for_invalid_format(
    client: TestClient,
    image_bytes_factory,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("logo.gif", image_bytes_factory("PNG"), "image/gif")},
    )

    assert response.status_code == 400
    assert "Supported formats" in response.json()["detail"]


def test_post_vectorize_returns_413_for_oversized_file(
    client: TestClient,
    oversized_png_bytes: bytes,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("too-large.png", oversized_png_bytes, "image/png")},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "The uploaded image exceeds the 5 MB limit."}


def test_post_vectorize_returns_500_for_unexpected_failures(
    client: TestClient,
    image_bytes_factory,
    monkeypatch,
) -> None:
    def broken_placeholder(_: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(
        routes_package.vectorize,
        "build_placeholder_vectorize_response",
        broken_placeholder,
    )

    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Vectorization failed unexpectedly."}
