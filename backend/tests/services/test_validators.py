from __future__ import annotations

import asyncio
from io import BytesIO

import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers

from src.utils.validators import ImageValidationError, validate_uploaded_image
from tests.fixtures.image_factory import FIVE_MEGABYTES, create_exactly_sized_png_bytes


def build_upload_file(filename: str, content: bytes, content_type: str) -> UploadFile:
    return UploadFile(
        filename=filename,
        file=BytesIO(content),
        headers=Headers({"content-type": content_type}),
    )


@pytest.mark.parametrize(
    ("filename", "content_type", "image_format"),
    [
        ("logo.png", "image/png", "PNG"),
        ("logo.jpg", "image/jpeg", "JPG"),
        ("logo.jpeg", "image/jpeg", "JPEG"),
        ("logo.webp", "image/webp", "WEBP"),
    ],
)
def test_validate_uploaded_image_accepts_supported_decodable_images(
    image_bytes_factory,
    filename: str,
    content_type: str,
    image_format: str,
) -> None:
    upload = build_upload_file(
        filename, image_bytes_factory(image_format), content_type
    )

    validated_image = asyncio.run(validate_uploaded_image(upload))

    assert validated_image.filename == filename
    assert validated_image.media_type == content_type
    assert validated_image.size_bytes > 0
    assert validated_image.width == 32
    assert validated_image.height == 32


def test_validate_uploaded_image_rejects_missing_image() -> None:
    with pytest.raises(ImageValidationError) as exc_info:
        asyncio.run(validate_uploaded_image(None))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "The 'image' field is required."


def test_validate_uploaded_image_rejects_unsupported_extension(
    image_bytes_factory,
) -> None:
    upload = build_upload_file("logo.gif", image_bytes_factory("PNG"), "image/gif")

    with pytest.raises(ImageValidationError) as exc_info:
        asyncio.run(validate_uploaded_image(upload))

    assert exc_info.value.status_code == 400
    assert "Supported formats" in exc_info.value.detail


def test_validate_uploaded_image_rejects_empty_file() -> None:
    upload = build_upload_file("empty.png", b"", "image/png")

    with pytest.raises(ImageValidationError) as exc_info:
        asyncio.run(validate_uploaded_image(upload))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "The uploaded image is empty."


def test_validate_uploaded_image_rejects_corrupted_image() -> None:
    upload = build_upload_file("broken.png", b"not-a-real-image", "image/png")

    with pytest.raises(ImageValidationError) as exc_info:
        asyncio.run(validate_uploaded_image(upload))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "The uploaded file is not a decodable image."


def test_validate_uploaded_image_accepts_file_exactly_at_size_limit() -> None:
    upload = build_upload_file(
        "limit.png",
        create_exactly_sized_png_bytes(FIVE_MEGABYTES),
        "image/png",
    )

    validated_image = asyncio.run(validate_uploaded_image(upload))

    assert validated_image.size_bytes == FIVE_MEGABYTES


def test_validate_uploaded_image_rejects_file_larger_than_size_limit(
    oversized_png_bytes: bytes,
) -> None:
    upload = build_upload_file("too-large.png", oversized_png_bytes, "image/png")

    with pytest.raises(ImageValidationError) as exc_info:
        asyncio.run(validate_uploaded_image(upload))

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == "The uploaded image exceeds the 5 MB limit."
