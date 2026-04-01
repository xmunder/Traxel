from __future__ import annotations

import builtins
import tempfile
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from src import routes as routes_package
from tests.fixtures.image_factory import create_photo_like_jpeg_bytes


def test_post_vectorize_returns_svg_and_metadata_for_valid_image(
    client: TestClient,
    image_bytes_factory,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 200
    payload = response.json()
    root = ElementTree.fromstring(payload["svg"])

    assert payload["svg"].startswith("<svg")
    assert root.find("{http://www.w3.org/2000/svg}path") is not None
    assert payload["metadata"]["colors_detected"] >= 1
    assert payload["metadata"]["paths_generated"] >= 1
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


def test_post_vectorize_accepts_valid_photo_like_jpeg_and_returns_svg(
    client: TestClient,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("photo.jpg", create_photo_like_jpeg_bytes(), "image/jpeg")},
    )

    assert response.status_code == 200
    payload = response.json()

    assert payload["svg"].startswith("<svg")
    assert payload["metadata"]["colors_detected"] >= 1
    assert payload["metadata"]["paths_generated"] >= 1
    assert payload["metadata"]["duration_ms"] >= 0


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
    def broken_processor(_: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(
        routes_package.vectorize,
        "process_image",
        broken_processor,
    )

    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Vectorization failed unexpectedly."}


def test_post_vectorize_processes_request_without_persisting_files(
    client: TestClient,
    image_bytes_factory,
    monkeypatch,
) -> None:
    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in ("w", "a", "x", "+")):
            raise AssertionError(
                f"Unexpected filesystem write attempted: {file!r} ({mode})"
            )
        return real_open(file, mode, *args, **kwargs)

    def fail_tempfile(*_args, **_kwargs):
        raise AssertionError("Unexpected temporary file creation during request.")

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(tempfile, "mkstemp", fail_tempfile)
    monkeypatch.setattr(tempfile, "mkdtemp", fail_tempfile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", fail_tempfile)

    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 200
    assert response.json()["metadata"]["paths_generated"] >= 1
