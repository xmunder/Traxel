def build_placeholder_svg(*, width: int, height: int) -> str:
    """Build a deterministic placeholder SVG for the MVP contract."""

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="Placeholder vectorization result">'
        '<rect width="100%" height="100%" fill="#ffffff" />'
        '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#111827" font-size="12">'
        "Vectorization pending"
        "</text>"
        "</svg>"
    )
