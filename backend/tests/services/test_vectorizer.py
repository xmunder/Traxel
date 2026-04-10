from __future__ import annotations

import numpy as np

from src.services.image_processor import ColorRegion, ProcessedImage


def build_processed_image(
    *regions: ColorRegion, width: int = 8, height: int = 8
) -> ProcessedImage:
    normalized_rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    palette = []

    return ProcessedImage(
        original_width=width,
        original_height=height,
        processing_width=width,
        processing_height=height,
        normalized_rgb=normalized_rgb,
        palette=palette,
        color_regions=list(regions),
    )


def build_region(
    mask: np.ndarray,
    *,
    rgb: tuple[int, int, int] = (255, 0, 0),
    color_hex: str = "#FF0000",
) -> ColorRegion:
    return ColorRegion(
        rgb=rgb,
        color_hex=color_hex,
        pixel_count=int(mask.sum()),
        mask=mask.astype(bool),
    )


def test_vectorizer_generates_svg_compatible_path_for_simple_region() -> None:
    from src.services.vectorizer import vectorize_processed_image

    mask = np.zeros((8, 8), dtype=bool)
    mask[1:6, 1:6] = True

    result = vectorize_processed_image(build_processed_image(build_region(mask)))

    assert result.width == 8
    assert result.height == 8
    assert result.paths_generated == 1
    assert len(result.paths) == 1
    assert result.paths[0].color_hex == "#FF0000"
    assert result.paths[0].d.startswith("M ")
    assert result.paths[0].d.endswith("Z")


def test_vectorizer_preserves_holes_with_multiple_subpaths() -> None:
    from src.services.vectorizer import vectorize_processed_image

    mask = np.zeros((8, 8), dtype=bool)
    mask[1:7, 1:7] = True
    mask[3:5, 3:5] = False

    result = vectorize_processed_image(build_processed_image(build_region(mask)))

    assert result.paths_generated == 1
    assert result.paths[0].d.count("M ") >= 2


def test_vectorizer_discards_marginal_regions() -> None:
    from src.services.vectorizer import vectorize_processed_image

    mask = np.zeros((8, 8), dtype=bool)
    mask[2, 2] = True

    result = vectorize_processed_image(build_processed_image(build_region(mask)))

    assert result.paths_generated == 0
    assert result.paths == []


def test_vectorizer_keeps_regions_separated_by_color() -> None:
    from src.services.vectorizer import vectorize_processed_image

    red_mask = np.zeros((8, 8), dtype=bool)
    red_mask[1:4, 1:4] = True
    blue_mask = np.zeros((8, 8), dtype=bool)
    blue_mask[4:7, 4:7] = True

    result = vectorize_processed_image(
        build_processed_image(
            build_region(red_mask, color_hex="#FF0000", rgb=(255, 0, 0)),
            build_region(blue_mask, color_hex="#0000FF", rgb=(0, 0, 255)),
        )
    )

    assert result.paths_generated == 2
    assert [path.color_hex for path in result.paths] == ["#FF0000", "#0000FF"]


def test_vectorizer_rescales_paths_to_original_dimensions() -> None:
    from src.services.vectorizer import vectorize_processed_image

    mask = np.zeros((8, 8), dtype=bool)
    mask[1:6, 1:6] = True

    processed = ProcessedImage(
        original_width=16,
        original_height=16,
        processing_width=8,
        processing_height=8,
        normalized_rgb=np.full((8, 8, 3), 255, dtype=np.uint8),
        palette=[],
        color_regions=[build_region(mask)],
    )

    result = vectorize_processed_image(processed)

    assert result.width == 16
    assert result.height == 16
    assert result.paths_generated == 1
    assert "M 2 2" in result.paths[0].d


def test_vectorizer_rescales_paths_anisotropically_when_scale_x_differs_from_scale_y() -> (
    None
):
    """scale_x=2.0, scale_y=4.0 — non-square upscale must apply distinct factors per axis."""
    from src.services.vectorizer import vectorize_processed_image

    # Processing: 16x8, Original: 32x32 → scale_x=2.0, scale_y=4.0
    # Mask: 4x4 region starting at (1,1) — area large enough to exceed MIN_PATH_AREA
    mask = np.zeros((8, 16), dtype=bool)
    mask[1:5, 1:5] = True

    processed = ProcessedImage(
        original_width=32,
        original_height=32,
        processing_width=16,
        processing_height=8,
        normalized_rgb=np.full((8, 16, 3), 255, dtype=np.uint8),
        palette=[],
        color_regions=[build_region(mask)],
    )

    result = vectorize_processed_image(processed)

    assert result.width == 32
    assert result.height == 32
    assert result.paths_generated == 1

    d = result.paths[0].d
    # First point in processing space is (1,1). With scale_x=2.0 scale_y=4.0 → (2, 4)
    assert "M 2 4" in d


def test_vectorizer_preserves_holes_after_upscale() -> None:
    """Holes (inner contours) must survive coordinate rescaling."""
    from src.services.vectorizer import vectorize_processed_image

    mask = np.zeros((8, 8), dtype=bool)
    mask[1:7, 1:7] = True
    mask[3:5, 3:5] = False  # hole

    processed = ProcessedImage(
        original_width=16,
        original_height=16,
        processing_width=8,
        processing_height=8,
        normalized_rgb=np.full((8, 8, 3), 255, dtype=np.uint8),
        palette=[],
        color_regions=[build_region(mask)],
    )

    result = vectorize_processed_image(processed)

    assert result.paths_generated == 1
    # Path must contain multiple subpaths (outer + inner/hole)
    assert result.paths[0].d.count("M ") >= 2


def test_vectorizer_formats_coordinates_stably_without_trailing_zeros() -> None:
    """_format_coordinate must not emit trailing zeros like '2.00'."""
    from src.services.vectorizer import _format_coordinate

    assert _format_coordinate(2.0) == "2"
    assert _format_coordinate(2.5) == "2.5"
    assert _format_coordinate(2.50) == "2.5"
    assert _format_coordinate(3.14) == "3.14"
    assert _format_coordinate(0.0) == "0"
