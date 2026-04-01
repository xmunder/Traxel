from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from src.services.image_processor import ProcessedImage


MIN_PATH_AREA = 4.0
SVG_EPSILON = 0.01


@dataclass(slots=True, frozen=True)
class VectorPath:
    color_hex: str
    d: str
    area: float


@dataclass(slots=True, frozen=True)
class VectorizationResult:
    width: int
    height: int
    paths: list[VectorPath]

    @property
    def paths_generated(self) -> int:
        return len(self.paths)


def vectorize_processed_image(processed_image: ProcessedImage) -> VectorizationResult:
    paths: list[VectorPath] = []

    for region in processed_image.color_regions:
        paths.extend(_vectorize_region(region.mask, region.color_hex))

    return VectorizationResult(
        width=processed_image.original_width,
        height=processed_image.original_height,
        paths=paths,
    )


def _vectorize_region(mask: np.ndarray, color_hex: str) -> list[VectorPath]:
    contour_mask = np.ascontiguousarray(mask.astype(np.uint8))
    contours, hierarchy = cv2.findContours(
        contour_mask,
        cv2.RETR_CCOMP,
        cv2.CHAIN_APPROX_SIMPLE,
    )

    if hierarchy is None or not contours:
        return []

    paths: list[VectorPath] = []
    contour_tree = hierarchy[0]

    for index, contour in enumerate(contours):
        parent_index = int(contour_tree[index][3])
        if parent_index != -1:
            continue

        area = float(cv2.contourArea(contour))
        if area < MIN_PATH_AREA:
            continue

        segments = [_contour_to_svg_path(contour)]
        child_index = int(contour_tree[index][2])

        while child_index != -1:
            child_contour = contours[child_index]
            if float(cv2.contourArea(child_contour)) >= SVG_EPSILON:
                segments.append(_contour_to_svg_path(child_contour))
            child_index = int(contour_tree[child_index][0])

        path_data = " ".join(segment for segment in segments if segment)
        if not path_data:
            continue

        paths.append(VectorPath(color_hex=color_hex, d=path_data, area=area))

    return paths


def _contour_to_svg_path(contour: np.ndarray) -> str:
    points = contour.reshape(-1, 2)
    if len(points) < 3:
        return ""

    commands = [
        f"M {_format_coordinate(points[0][0])} {_format_coordinate(points[0][1])}"
    ]
    for point in points[1:]:
        commands.append(
            f"L {_format_coordinate(point[0])} {_format_coordinate(point[1])}"
        )
    commands.append("Z")
    return " ".join(commands)


def _format_coordinate(value: int | float) -> str:
    numeric_value = float(value)
    if numeric_value.is_integer():
        return str(int(numeric_value))
    return f"{numeric_value:.2f}".rstrip("0").rstrip(".")
