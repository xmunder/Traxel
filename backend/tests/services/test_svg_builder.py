from __future__ import annotations

from xml.etree import ElementTree

from src.services.vectorizer import VectorPath, VectorizationResult


def test_svg_builder_creates_valid_svg_with_viewbox_and_dimensions() -> None:
    from src.services.svg_builder import build_svg_document

    svg = build_svg_document(
        VectorizationResult(
            width=12,
            height=8,
            paths=[
                VectorPath(
                    color_hex="#FF0000", d="M 0 0 L 4 0 L 4 4 L 0 4 Z", area=16.0
                )
            ],
        )
    )

    root = ElementTree.fromstring(svg)

    assert root.tag.endswith("svg")
    assert root.attrib["viewBox"] == "0 0 12 8"
    assert root.attrib["width"] == "12"
    assert root.attrib["height"] == "8"


def test_svg_builder_preserves_colors_and_discards_empty_paths() -> None:
    from src.services.svg_builder import build_svg_document

    svg = build_svg_document(
        VectorizationResult(
            width=12,
            height=8,
            paths=[
                VectorPath(
                    color_hex="#FF0000", d="M 0 0 L 4 0 L 4 4 L 0 4 Z", area=16.0
                ),
                VectorPath(color_hex="#00FF00", d="", area=0.0),
                VectorPath(
                    color_hex="#0000FF", d="M 5 0 L 9 0 L 9 4 L 5 4 Z", area=16.0
                ),
            ],
        )
    )

    root = ElementTree.fromstring(svg)
    paths = root.findall("{http://www.w3.org/2000/svg}path")

    assert len(paths) == 2
    assert [element.attrib["fill"] for element in paths] == ["#FF0000", "#0000FF"]


def test_svg_builder_keeps_stable_visual_order() -> None:
    from src.services.svg_builder import build_svg_document

    svg = build_svg_document(
        VectorizationResult(
            width=12,
            height=8,
            paths=[
                VectorPath(
                    color_hex="#111111", d="M 0 0 L 2 0 L 2 2 L 0 2 Z", area=4.0
                ),
                VectorPath(
                    color_hex="#222222", d="M 3 0 L 5 0 L 5 2 L 3 2 Z", area=4.0
                ),
                VectorPath(
                    color_hex="#333333", d="M 6 0 L 8 0 L 8 2 L 6 2 Z", area=4.0
                ),
            ],
        )
    )

    root = ElementTree.fromstring(svg)
    paths = root.findall("{http://www.w3.org/2000/svg}path")

    assert [element.attrib["fill"] for element in paths] == [
        "#111111",
        "#222222",
        "#333333",
    ]


def test_svg_builder_outputs_editor_compatible_structure() -> None:
    from src.services.svg_builder import build_svg_document

    svg = build_svg_document(
        VectorizationResult(
            width=12,
            height=8,
            paths=[
                VectorPath(
                    color_hex="#FF0000", d="M 0 0 L 4 0 L 4 4 L 0 4 Z", area=16.0
                )
            ],
        )
    )

    root = ElementTree.fromstring(svg)
    path = root.find("{http://www.w3.org/2000/svg}path")

    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert path is not None
    assert path.attrib["fill-rule"] == "evenodd"
    assert path.attrib["clip-rule"] == "evenodd"
