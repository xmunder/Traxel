from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from starlette.datastructures import UploadFile

from src.config import get_settings


@dataclass(slots=True)
class ValidatedImage:
    filename: str
    media_type: str
    content: bytes
    size_bytes: int
    width: int
    height: int
    image_format: str


@dataclass(slots=True)
class ImageValidationError(Exception):
    status_code: int
    detail: str


def _extract_extension(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def _read_image_metadata(content: bytes) -> tuple[int, int, str]:
    try:
        with Image.open(BytesIO(content)) as image:
            image.load()
            width, height = image.size
            image_format = image.format or "UNKNOWN"
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageValidationError(
            status_code=400,
            detail="The uploaded file is not a decodable image.",
        ) from exc

    return width, height, image_format


async def validate_uploaded_image(upload: UploadFile | None) -> ValidatedImage:
    settings = get_settings()

    if upload is None:
        raise ImageValidationError(
            status_code=400, detail="The 'image' field is required."
        )

    filename = upload.filename or "upload"
    extension = _extract_extension(filename)
    media_type = upload.content_type or ""

    if (
        extension not in settings.allowed_extensions
        or media_type not in settings.allowed_content_types
    ):
        raise ImageValidationError(
            status_code=400,
            detail="Unsupported image format. Supported formats: PNG, JPG, JPEG, WEBP.",
        )

    content = await upload.read(settings.max_file_size + 1)
    await upload.close()

    if not content:
        raise ImageValidationError(
            status_code=400, detail="The uploaded image is empty."
        )

    if len(content) > settings.max_file_size:
        raise ImageValidationError(
            status_code=413,
            detail="The uploaded image exceeds the 5 MB limit.",
        )

    width, height, image_format = _read_image_metadata(content)

    return ValidatedImage(
        filename=filename,
        media_type=media_type,
        content=content,
        size_bytes=len(content),
        width=width,
        height=height,
        image_format=image_format,
    )
