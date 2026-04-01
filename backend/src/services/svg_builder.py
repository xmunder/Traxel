from __future__ import annotations

from xml.etree.ElementTree import Element, SubElement, tostring

from src.services.vectorizer import VectorizationResult


def build_svg_document(vectorization: VectorizationResult) -> str:
    svg = Element(
        "svg",
        {
            "xmlns": "http://www.w3.org/2000/svg",
            "version": "1.1",
            "viewBox": f"0 0 {vectorization.width} {vectorization.height}",
            "width": str(vectorization.width),
            "height": str(vectorization.height),
        },
    )

    for path in vectorization.paths:
        if not path.d.strip():
            continue

        SubElement(
            svg,
            "path",
            {
                "d": path.d,
                "fill": path.color_hex,
                "fill-rule": "evenodd",
                "clip-rule": "evenodd",
            },
        )

    return tostring(svg, encoding="unicode", short_empty_elements=True)
