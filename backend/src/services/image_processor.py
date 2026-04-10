from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any, cast

import cv2
import numpy as np
from PIL import Image

from src.config import get_settings
from src.utils.validators import ValidatedImage


DEFAULT_BACKGROUND_RGB = (255, 255, 255)
MIN_REGION_PIXELS = 2


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
        return len(self.color_regions)


def process_image(validated_image: ValidatedImage) -> ProcessedImage:
    settings = get_settings()
    normalized_rgb = _normalize_image(validated_image.content)
    processing_rgb = _resize_for_processing(
        normalized_rgb, max_dimension=settings.processing_max_dimension
    )
    quantized_rgb = _quantize_rgb(
        processing_rgb, max_colors=settings.default_max_colors
    )
    color_regions = _build_color_regions(quantized_rgb)
    palette = [
        DominantColor(
            rgb=region.rgb,
            hex=region.color_hex,
            pixel_count=region.pixel_count,
        )
        for region in color_regions
    ]
    original_height, original_width = normalized_rgb.shape[:2]
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


def _normalize_image(content: bytes) -> np.ndarray:
    with Image.open(BytesIO(content)) as image:
        image.load()

        if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
            rgba_image = image.convert("RGBA")
            background = Image.new(
                "RGBA", rgba_image.size, DEFAULT_BACKGROUND_RGB + (255,)
            )
            image = Image.alpha_composite(background, rgba_image).convert("RGB")
        else:
            image = image.convert("RGB")

    return np.array(image, dtype=np.uint8)


def _resize_for_processing(rgb_image: np.ndarray, *, max_dimension: int) -> np.ndarray:
    height, width = rgb_image.shape[:2]
    longest_side = max(width, height)

    if longest_side <= max_dimension:
        return rgb_image.copy()

    scale = max_dimension / float(longest_side)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))

    return cv2.resize(
        rgb_image,
        (resized_width, resized_height),
        interpolation=cv2.INTER_AREA,
    )


def _quantize_rgb(rgb_image: np.ndarray, *, max_colors: int) -> np.ndarray:
    flat_pixels = rgb_image.reshape(-1, 3)
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
    return quantized_pixels.reshape(rgb_image.shape)


def _build_color_regions(quantized_rgb: np.ndarray) -> list[ColorRegion]:
    flat_pixels = quantized_rgb.reshape(-1, 3)
    unique_colors, counts = np.unique(flat_pixels, axis=0, return_counts=True)

    regions: list[ColorRegion] = []
    for color, _count in sorted(
        zip(unique_colors, counts, strict=True),
        key=lambda item: int(item[1]),
        reverse=True,
    ):
        raw_mask = np.all(quantized_rgb == color, axis=2).astype(np.uint8)
        cleaned_mask = _remove_small_components(raw_mask)
        pixel_count = int(cleaned_mask.sum())

        if pixel_count < MIN_REGION_PIXELS:
            continue

        rgb = cast(tuple[int, int, int], (int(color[0]), int(color[1]), int(color[2])))
        regions.append(
            ColorRegion(
                rgb=rgb,
                color_hex=_to_hex(rgb),
                pixel_count=pixel_count,
                mask=cleaned_mask.astype(bool),
            )
        )

    return regions


def _remove_small_components(mask: np.ndarray) -> np.ndarray:
    component_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        mask, connectivity=8
    )
    cleaned_mask = np.zeros_like(mask, dtype=np.uint8)

    for component_index in range(1, component_count):
        area = int(stats[component_index, cv2.CC_STAT_AREA])
        if area >= MIN_REGION_PIXELS:
            cleaned_mask[labels == component_index] = 1

    return cleaned_mask


def _to_hex(rgb: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in rgb)
