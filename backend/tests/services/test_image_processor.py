from __future__ import annotations

from src.utils.validators import ValidatedImage
from tests.fixtures.image_factory import (
    create_multicolor_logo_png_bytes,
    create_noisy_multicolor_logo_png_bytes,
    create_transparent_logo_png_bytes,
)


def build_validated_image(
    content: bytes, *, filename: str = "logo.png"
) -> ValidatedImage:
    return ValidatedImage(
        filename=filename,
        media_type="image/png",
        content=content,
        size_bytes=len(content),
        width=0,
        height=0,
        image_format="PNG",
    )


def test_process_image_normalizes_transparency_and_preserves_dimensions() -> None:
    from src.services.image_processor import process_image

    processed = process_image(
        build_validated_image(create_transparent_logo_png_bytes())
    )

    assert processed.original_width == 8
    assert processed.original_height == 8
    assert processed.processing_width == 8
    assert processed.processing_height == 8
    assert any(color.hex == "#FFFFFF" for color in processed.palette)
    assert any(color.hex == "#FF0000" for color in processed.palette)
    assert len(processed.color_regions) == 2


def test_process_image_quantizes_to_supported_color_limit() -> None:
    from src.services.image_processor import process_image

    processed = process_image(build_validated_image(create_multicolor_logo_png_bytes()))

    assert 1 <= processed.colors_detected <= 8
    assert {region.color_hex for region in processed.color_regions} == {
        "#FF0000",
        "#00FF00",
        "#0000FF",
        "#FFFF00",
    }
    assert all(region.mask.any() for region in processed.color_regions)


def test_process_image_removes_single_pixel_noise_from_color_masks() -> None:
    from src.services.image_processor import process_image

    processed = process_image(
        build_validated_image(create_noisy_multicolor_logo_png_bytes())
    )

    assert {region.color_hex for region in processed.color_regions} == {
        "#FF0000",
        "#0000FF",
    }
    assert processed.colors_detected == 2
