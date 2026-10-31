"""Per-entity data."""

from parallax import ContentRef, component, field

from game.content import WordKindDef


@component("word")
class Word:
    """A falling word. `typed` letters of it have been struck correctly."""
    text: str = field()
    typed: int = field(0, min=0)
    kind: ContentRef[WordKindDef] = field()
