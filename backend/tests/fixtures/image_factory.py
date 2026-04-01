from __future__ import annotations

from io import BytesIO

from PIL import Image
from PIL.ImageDraw import Draw


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


def create_transparent_logo_png_bytes() -> bytes:
    image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    drawer = Draw(image)
    drawer.rectangle((1, 1, 6, 6), fill=(255, 0, 0, 255))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create_multicolor_logo_png_bytes() -> bytes:
    image = Image.new("RGB", (12, 12), (255, 255, 255))
    drawer = Draw(image)
    drawer.rectangle((0, 0, 5, 5), fill=(255, 0, 0))
    drawer.rectangle((6, 0, 11, 5), fill=(0, 255, 0))
    drawer.rectangle((0, 6, 5, 11), fill=(0, 0, 255))
    drawer.rectangle((6, 6, 11, 11), fill=(255, 255, 0))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create_noisy_multicolor_logo_png_bytes() -> bytes:
    image = Image.new("RGB", (10, 10), (255, 0, 0))

    for x in range(5, 10):
        for y in range(10):
            image.putpixel((x, y), (0, 0, 255))

    image.putpixel((0, 0), (0, 255, 0))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create_monochrome_logo_png_bytes() -> bytes:
    image = Image.new("RGB", (16, 16), (255, 255, 255))
    drawer = Draw(image)
    drawer.rectangle((3, 3, 12, 12), fill=(0, 0, 0))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create_photo_like_jpeg_bytes() -> bytes:
    image = Image.new("RGB", (24, 24))

    for x in range(24):
        for y in range(24):
            red = int((x / 23) * 255)
            green = int((y / 23) * 255)
            blue = int((((x + y) / 46) * 155) + 60)
            image.putpixel((x, y), (red, green, blue))

    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()
