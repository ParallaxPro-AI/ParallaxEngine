"""Content registry: the tile ladder."""

from parallax import Color, content, field


@content("tile", order="value")
class TileDef:
    """How one value on the ladder looks. One entry per power of two."""
    value: int = field(min=2)
    color: Color = field(doc="Tile face, and the tint of its fuse burst.")
    text_color: Color = field()
    text_size: float = field(0.5, unit="m")
