"""Panel art as `data:image/svg+xml` images (an `<img>`'s src): the template's glyphs,
crests and sigils, coloured per champion or category."""


def svg_image(view_box: str, body: str) -> str:
    """An SVG document (`body` is its inner markup, single-quoted attributes) as a data URL."""
    svg = f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='{view_box}'>{body}</svg>"
    return "data:image/svg+xml," + (svg.replace("%", "%25").replace("#", "%23").replace("<", "%3C")
                                    .replace(">", "%3E").replace('"', "'").replace(" ", "%20"))


def path_image(view_box: str, d: str, fill: str) -> str:
    """One filled path."""
    return svg_image(view_box, f"<path d='{d}' fill='{fill}'/>")
