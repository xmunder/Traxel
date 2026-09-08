from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any, cast

import cv2
import numpy as np
from PIL import Image

from src.config import get_settings
from src.utils.validators import ValidatedImage


MIN_REGION_PIXELS = 2
ALPHA_BUCKET_SIZE = 16


@dataclass(slots=True, frozen=True)
class DominantColor:
    rgb: tuple[int, int, int]
    hex: str
    pixel_count: int


@dataclass(slots=True, frozen=True)
class ColorRegion:
    rgb: tuple[int, int, int]
    color_hex: str
    pixel_count: int
    mask: np.ndarray
    opacity: float = 1.0


@dataclass(slots=True, frozen=True)
class ProcessedImage:
    original_width: int
    original_height: int
    processing_width: int
    processing_height: int
    normalized_rgb: np.ndarray
    palette: list[DominantColor]
    color_regions: list[ColorRegion]

    @property
    def colors_detected(self) -> int:
        return len(self.palette)


def process_image(validated_image: ValidatedImage) -> ProcessedImage:
    settings = get_settings()
    with Image.open(BytesIO(validated_image.content), formats=("PNG", "JPEG", "WEBP")) as image:
        original_width, original_height = image.size
        rgba = image.convert("RGBA")
        # Pillow resizes RGBA using premultiplied alpha: hidden RGB values
        # cannot bleed into visible edges, as happens when compositing on white.
        rgba.thumbnail(
            (settings.processing_max_dimension, settings.processing_max_dimension),
            Image.Resampling.BOX,
        )
        pixels = np.array(rgba, dtype=np.uint8)
    processing_rgb = pixels[:, :, :3]
    alpha = pixels[:, :, 3]
    visible = alpha > 0
    quantized_rgb = _quantize_rgb(
        processing_rgb, max_colors=settings.default_max_colors, visible=visible
    )
    color_regions = _build_color_regions(quantized_rgb, alpha=alpha)
    color_counts: dict[tuple[int, int, int], int] = {}
    for region in color_regions:
        color_counts[region.rgb] = color_counts.get(region.rgb, 0) + region.pixel_count
    palette = [
        DominantColor(
            rgb=rgb,
            hex=_to_hex(rgb),
            pixel_count=count,
        )
        for rgb, count in color_counts.items()
    ]
    processing_height, processing_width = quantized_rgb.shape[:2]

    return ProcessedImage(
        original_width=original_width,
        original_height=original_height,
        processing_width=processing_width,
        processing_height=processing_height,
        normalized_rgb=quantized_rgb,
        palette=palette,
        color_regions=color_regions,
    )


def _quantize_rgb(
    rgb_image: np.ndarray, *, max_colors: int, visible: np.ndarray
) -> np.ndarray:
    flat_pixels = rgb_image[visible]
    if not len(flat_pixels):
        return np.zeros_like(rgb_image)
    unique_colors = np.unique(flat_pixels, axis=0)

    if len(unique_colors) <= max_colors:
        return rgb_image.copy()

    criteria = (
        cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
        20,
        1.0,
    )
    kmeans = cast(Any, cv2.kmeans)
    compactness, labels, centers = kmeans(
        np.float32(flat_pixels), max_colors, None, criteria, 5, cv2.KMEANS_PP_CENTERS
    )
    _ = compactness

    quantized_pixels = np.clip(np.round(centers), 0, 255).astype(np.uint8)[
        labels.flatten()
    ]
    result = np.zeros_like(rgb_image)
    result[visible] = quantized_pixels
    return result


def _build_color_regions(quantized_rgb: np.ndarray, *, alpha: np.ndarray) -> list[ColorRegion]:
    visible = alpha > 0
    flat_pixels = quantized_rgb[visible]
    unique_colors, counts = np.unique(flat_pixels, axis=0, return_counts=True)
    alpha_bands = alpha // ALPHA_BUCKET_SIZE
    alpha_bands = np.where(alpha == 255, 16, alpha_bands)

    regions: list[ColorRegion] = []
    for color, _count in sorted(
        zip(unique_colors, counts, strict=True),
        key=lambda item: int(item[1]),
        reverse=True,
    ):
        raw_mask = (np.all(quantized_rgb == color, axis=2) & visible).astype(np.uint8)
        cleaned_mask = _remove_small_components(raw_mask)
        pixel_count = int(cleaned_mask.sum())

        if pixel_count < MIN_REGION_PIXELS:
            continue

        rgb = cast(tuple[int, int, int], (int(color[0]), int(color[1]), int(color[2])))
        # Disjoint opacity bands bound SVG complexity. Keep fully opaque
        # pixels in their own band; average the original alpha within others.
        for band in np.unique(alpha_bands[cleaned_mask.astype(bool)]):
            mask = (cleaned_mask > 0) & (alpha_bands == band)
            regions.append(
                ColorRegion(
                    rgb=rgb,
                    color_hex=_to_hex(rgb),
                    pixel_count=int(mask.sum()),
                    mask=mask,
                    opacity=float(alpha[mask].mean()) / 255.0,
                )
            )

    return regions


def _remove_small_components(mask: np.ndarray) -> np.ndarray:
    _component_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        mask, connectivity=8
    )
    keep = stats[:, cv2.CC_STAT_AREA] >= MIN_REGION_PIXELS
    keep[0] = False  # Label zero is always background, irrespective of area.
    return keep[labels].astype(np.uint8)


def _to_hex(rgb: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in rgb)
