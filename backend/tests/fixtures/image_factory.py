from __future__ import annotations

from io import BytesIO

from PIL import Image


FIVE_MEGABYTES = 5 * 1024 * 1024


def create_image_bytes(
    image_format: str,
    size: tuple[int, int] = (32, 32),
    color: tuple[int, int, int, int] = (20, 40, 60, 255),
) -> bytes:
    mode = "RGBA" if image_format.upper() in {"PNG", "WEBP"} else "RGB"
    image = Image.new(mode, size, color if mode == "RGBA" else color[:3])
    buffer = BytesIO()
    save_format = "JPEG" if image_format.upper() == "JPG" else image_format.upper()
    image.save(buffer, format=save_format)
    return buffer.getvalue()


def create_exactly_sized_png_bytes(target_size: int = FIVE_MEGABYTES) -> bytes:
    png_bytes = create_image_bytes("PNG", size=(64, 64))
    padding_size = target_size - len(png_bytes)

    if padding_size < 0:
        raise ValueError("Base PNG is larger than the requested target size.")

    return png_bytes + (b" " * padding_size)


def create_oversized_png_bytes() -> bytes:
    return create_exactly_sized_png_bytes(FIVE_MEGABYTES + 1)
