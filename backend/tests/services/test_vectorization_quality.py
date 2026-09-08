from io import BytesIO
from xml.etree import ElementTree as ET

import cv2
import numpy as np
import pytest
from PIL import Image

from src.services import image_processor
from src.services.image_processor import _remove_small_components, process_image
from src.services.svg_builder import build_svg_document
from src.services.vectorizer import _simplify_contour, vectorize_processed_image
from tests.services.test_image_processor import build_validated_image


def process_pil(image):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return process_image(build_validated_image(buffer.getvalue()))


def test_component_filter_matches_reference_with_many_islands():
    mask = np.zeros((128, 128), dtype=np.uint8)
    mask[::4, ::4] = 1
    mask[::4, 1::4] = 1
    mask[2, 2] = 1  # isolated noise
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    expected = np.zeros_like(mask)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= 2:
            expected[labels == index] = 1
    np.testing.assert_array_equal(_remove_small_components(mask), expected)
    assert not _remove_small_components(np.zeros_like(mask)).any()


@pytest.mark.parametrize("mode,color", [("RGBA", (255, 30, 80, 0)), ("LA", (128, 0))])
def test_fully_transparent_image_has_no_paths(mode, color):
    result = process_pil(Image.new(mode, (16, 16), color))
    assert result.colors_detected == 0
    assert vectorize_processed_image(result).paths == []


def test_palette_transparency_does_not_create_a_background():
    image = Image.new("P", (16, 16), 0)
    image.putpalette([0, 255, 0, 255, 0, 0] + [0] * 762)
    image.info["transparency"] = 0
    image.paste(1, (4, 4, 12, 12))
    result = process_pil(image)
    assert [color.hex for color in result.palette] == ["#FF0000"]
    assert result.color_regions[0].pixel_count == 64


def test_opacity_reaches_svg_without_whitening_color():
    image = Image.new("RGBA", (32, 16), (255, 0, 0, 128))
    image.paste((255, 0, 0, 255), (16, 0, 32, 16))
    result = process_pil(image)
    assert result.colors_detected == 1
    assert result.palette[0].pixel_count == 512
    svg = ET.fromstring(build_svg_document(vectorize_processed_image(result)))
    paths = list(svg)
    assert len(paths) == 2
    assert all(path.attrib["fill"] == "#FF0000" for path in paths)
    assert sorted(float(path.attrib.get("fill-opacity", "1")) for path in paths) == pytest.approx([128 / 255, 1], abs=1e-6)


def test_resize_excludes_hidden_rgb_from_visible_edges(monkeypatch):
    settings = image_processor.get_settings().model_copy(update={"processing_max_dimension": 16})
    monkeypatch.setattr(image_processor, "get_settings", lambda: settings)
    image = Image.new("RGBA", (64, 64), (0, 255, 0, 0))
    image.paste((255, 0, 0, 255), (13, 13, 51, 51))
    result = process_pil(image)
    assert [color.hex for color in result.palette] == ["#FF0000"]
    assert all(region.opacity > 0 for region in result.color_regions)
    assert not any(region.mask[0, 0] for region in result.color_regions)


def test_simplification_reduces_circle_nodes_with_bounded_pixel_error():
    mask = np.zeros((128, 128), dtype=np.uint8)
    cv2.circle(mask, (64, 64), 48, 1, -1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = contours[0]
    simplified = _simplify_contour(contour, 0.5)
    assert len(simplified) < len(contour) * 0.8
    reconstructed = np.zeros_like(mask)
    cv2.fillPoly(reconstructed, [simplified], 1)
    assert np.count_nonzero(mask != reconstructed) / np.count_nonzero(mask) < 0.01
    np.testing.assert_array_equal(_simplify_contour(contour, 0), contour)


def test_transparent_ring_retains_hole_and_svg_uses_evenodd():
    rgba = np.zeros((64, 64, 4), dtype=np.uint8)
    cv2.circle(rgba, (32, 32), 24, (255, 0, 0, 255), -1)
    cv2.circle(rgba, (32, 32), 10, (0, 0, 0, 0), -1)
    svg = ET.fromstring(build_svg_document(vectorize_processed_image(process_pil(Image.fromarray(rgba)))))
    assert len(svg) == 1
    assert svg[0].attrib["d"].count("M ") == 2
    assert svg[0].attrib["fill-rule"] == "evenodd"


def test_simplification_does_not_collapse_tiny_hole():
    contour = np.array([[[0, 1]], [[1, 0]], [[2, 0]], [[3, 1]], [[2, 2]], [[1, 2]]], dtype=np.int32)
    simplified = _simplify_contour(contour, 2)
    assert len(simplified) >= 3
    assert cv2.contourArea(simplified) == pytest.approx(cv2.contourArea(contour), rel=0.01)
