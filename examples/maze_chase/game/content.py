"""Content registries: the maze, the levels of the descent and the four Stalkers.
Names are written inline in each entry's JSON."""

from parallax import Color, Localized, content, field
from parallax.values import Cell


@content("maze")
class MazeDef:
    """The maze as an ASCII grid, top row first. "#" wall, "." pip, "o" flare, "P" the
    Gobbler's start, "1".."4" the Stalkers' starts (by `StalkerDef.number`), "-" the
    ghost-house door (where an eaten Stalker revives), " " open floor without a pip.
    Keep it rectangular and walled."""
    rows: list[str] = field()
    tile: float = field(0.62, unit="m", doc="World size of one cell.")


@content("level", order="number")
class LevelDef:
    """One level of the descent: the same maze refilled, faster and less forgiving."""
    number: int = field(min=1)
    name: Localized = field()
    stalker_speed: float = field(1.0, min=0.1, doc="Multiplies every Stalker speed.")
    fright_seconds: float = field(7.0, unit="s", doc="How long a flare keeps the Stalkers edible.")


@content("stalker", order="number")
class StalkerDef:
    """One hunter. In chase mode it targets the Gobbler's cell `lead` cells along its
    heading (negative = behind); a shy Stalker breaks for its corner whenever it is
    within `shy_within` cells of the Gobbler."""
    number: int = field(min=1, doc="Starts on this digit in the maze.")
    name: Localized = field()
    style: Localized = field(doc="One word for the title screen: chaser, ambusher…")
    color: Color = field()
    corner: Cell = field(doc="The cell it heads for in scatter mode: [column, row], counted "
                             "from the top-left of the ASCII maze.")
    lead: int = field(0)
    shy_within: int = field(0, min=0, doc="0 = never shy.")
