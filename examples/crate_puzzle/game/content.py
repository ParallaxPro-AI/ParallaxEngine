"""Content registry: the levels of a shift, played in `number` order."""

from parallax import Localized, content, field


@content("level", order="number")
class LevelDef:
    """One warehouse floor in Sokoban ASCII, top line first: '#' wall, ' ' floor,
    '@' bot, '$' crate, '.' dock pad, '*' crate on a pad, '+' bot on a pad."""
    number: int = field(min=1)
    name: Localized = field()
    hint: Localized = field()
    rows: list[str] = field()
