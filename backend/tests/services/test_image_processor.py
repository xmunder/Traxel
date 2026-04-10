from __future__ import annotations

import builtins
import tempfile

from src.utils.validators import ValidatedImage
from tests.fixtures.image_factory import (
    create_image_bytes,
    create_monochrome_logo_png_bytes,
    create_multicolor_logo_png_bytes,
    create_noisy_multicolor_logo_png_bytes,
    create_photo_like_jpeg_bytes,
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


def test_process_image_keeps_monochrome_images_as_single_region() -> None:
    from src.services.image_processor import process_image

    processed = process_image(build_validated_image(create_monochrome_logo_png_bytes()))

    assert processed.original_width == 16
    assert processed.original_height == 16
    assert processed.colors_detected == 2
    assert {region.color_hex for region in processed.color_regions} == {
        "#FFFFFF",
        "#000000",
    }
    black_region = next(
        region for region in processed.color_regions if region.color_hex == "#000000"
    )
    assert black_region.pixel_count == 100


def test_process_image_accepts_complex_photo_like_image_without_failing() -> None:
    from src.services.image_processor import process_image

    processed = process_image(
        build_validated_image(
            create_photo_like_jpeg_bytes(),
            filename="photo.jpg",
        )
    )

    assert processed.original_width == 24
    assert processed.original_height == 24
    assert 1 <= processed.colors_detected <= 8
    assert len(processed.palette) == processed.colors_detected
    assert all(region.pixel_count > 0 for region in processed.color_regions)


def test_process_image_downscales_large_images_for_processing(monkeypatch) -> None:
    from src.services import image_processor

    settings = image_processor.get_settings().model_copy(
        update={"processing_max_dimension": 32}
    )
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)

    processed = image_processor.process_image(
        build_validated_image(
            create_image_bytes("PNG", size=(96, 48)),
        )
    )

    assert processed.original_width == 96
    assert processed.original_height == 48
    assert processed.processing_width == 32
    assert processed.processing_height == 16


def test_process_image_does_not_resize_images_within_max_dimension(monkeypatch) -> None:
    from src.services import image_processor

    settings = image_processor.get_settings().model_copy(
        update={"processing_max_dimension": 64}
    )
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)

    processed = image_processor.process_image(
        build_validated_image(
            create_image_bytes("PNG", size=(48, 32)),
        )
    )

    assert processed.original_width == 48
    assert processed.original_height == 32
    assert processed.processing_width == 48
    assert processed.processing_height == 32


def test_process_image_preserves_aspect_ratio_when_downscaling(monkeypatch) -> None:
    from src.services import image_processor

    settings = image_processor.get_settings().model_copy(
        update={"processing_max_dimension": 100}
    )
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)

    # 400x200 → longest_side=400 → scale=100/400=0.25 → 100x50
    processed = image_processor.process_image(
        build_validated_image(
            create_image_bytes("PNG", size=(400, 200)),
        )
    )

    assert processed.original_width == 400
    assert processed.original_height == 200
    assert processed.processing_width == 100
    assert processed.processing_height == 50
    original_ratio = processed.original_width / processed.original_height
    processing_ratio = processed.processing_width / processed.processing_height
    assert abs(original_ratio - processing_ratio) < 0.02


def test_process_image_preserves_original_dimensions_alongside_processing_dimensions(
    monkeypatch,
) -> None:
    from src.services import image_processor

    settings = image_processor.get_settings().model_copy(
        update={"processing_max_dimension": 50}
    )
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)

    processed = image_processor.process_image(
        build_validated_image(
            create_image_bytes("PNG", size=(200, 100)),
        )
    )

    assert processed.original_width == 200
    assert processed.original_height == 100
    assert processed.processing_width < processed.original_width
    assert processed.processing_height < processed.original_height
    assert processed.processing_width <= 50
    assert processed.processing_height <= 50


def test_process_image_keeps_intermediate_processing_in_memory(monkeypatch) -> None:
    from src.services.image_processor import process_image

    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in ("w", "a", "x", "+")):
            raise AssertionError(
                f"Unexpected filesystem write attempted: {file!r} ({mode})"
            )
        return real_open(file, mode, *args, **kwargs)

    def fail_tempfile(*_args, **_kwargs):
        raise AssertionError("Unexpected temporary file creation during processing.")

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(tempfile, "mkstemp", fail_tempfile)
    monkeypatch.setattr(tempfile, "mkdtemp", fail_tempfile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", fail_tempfile)

    processed = process_image(build_validated_image(create_multicolor_logo_png_bytes()))

    assert processed.colors_detected >= 1
