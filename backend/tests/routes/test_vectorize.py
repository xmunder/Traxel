from __future__ import annotations

import builtins
import logging
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


def test_post_vectorize_includes_observability_headers(
    client: TestClient,
    image_bytes_factory,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"]
    assert int(response.headers["X-Process-Time-MS"]) >= 0


def test_post_vectorize_echoes_incoming_request_id(
    client: TestClient,
    image_bytes_factory,
) -> None:
    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
        headers={"X-Request-ID": "req-123"},
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "req-123"


def test_post_vectorize_logs_validation_warning_with_request_context(
    client: TestClient,
    caplog,
) -> None:
    with caplog.at_level(logging.WARNING, logger="vectorizer"):
        response = client.post(
            "/vectorize",
            files={"other": ("note.txt", b"hello", "text/plain")},
            headers={"X-Request-ID": "req-validation"},
        )

    assert response.status_code == 400

    validation_record = next(
        record
        for record in caplog.records
        if record.getMessage() == "Image validation failed"
    )
    assert validation_record.request_id == "req-validation"
    assert validation_record.method == "POST"
    assert validation_record.path == "/vectorize"
    assert validation_record.status_code == 400
    assert validation_record.error_detail == "The 'image' field is required."


def test_post_vectorize_logs_unexpected_errors_with_request_context(
    client: TestClient,
    image_bytes_factory,
    monkeypatch,
    caplog,
) -> None:
    def broken_processor(_: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(routes_package.vectorize, "process_image", broken_processor)

    with caplog.at_level(logging.ERROR, logger="vectorizer"):
        response = client.post(
            "/vectorize",
            files={"image": ("logo.png", image_bytes_factory("PNG"), "image/png")},
            headers={"X-Request-ID": "req-error"},
        )

    assert response.status_code == 500

    error_record = next(
        record
        for record in caplog.records
        if record.getMessage() == "Unexpected vectorization failure"
    )
    assert error_record.request_id == "req-error"
    assert error_record.method == "POST"
    assert error_record.path == "/vectorize"
    assert error_record.filename == "vectorize.py"
    assert error_record.error_type == "RuntimeError"
    assert error_record.error_detail == "boom"


def test_post_vectorize_svg_preserves_original_image_dimensions_when_downscaled(
    client: TestClient,
    monkeypatch,
) -> None:
    """SVG width/height/viewBox must match the uploaded image even when backend
    internally downscales for processing."""
    from src.services import image_processor
    from tests.fixtures.image_factory import create_image_bytes

    # Force a very low processing limit so the 64x64 image is always downscaled
    settings = image_processor.get_settings().model_copy(
        update={"processing_max_dimension": 16}
    )
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)

    image_64 = create_image_bytes("PNG", size=(64, 64))
    response = client.post(
        "/vectorize",
        files={"image": ("logo.png", image_64, "image/png")},
    )

    assert response.status_code == 200
    from xml.etree import ElementTree

    payload = response.json()
    root = ElementTree.fromstring(payload["svg"])

    assert root.attrib["width"] == "64"
    assert root.attrib["height"] == "64"
    assert root.attrib["viewBox"] == "0 0 64 64"
