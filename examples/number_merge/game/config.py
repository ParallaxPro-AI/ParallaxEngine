"""Game-wide tunables: config/rules.json, read with `ctx.config(Rules)`."""

from parallax import config, field


@config("rules")
class Rules:
    target: int = field(2048, doc="Forging a tile of this value wins.")
    start_tiles: int = field(2, min=1)
    four_chance: float = field(0.1, min=0, max=1, doc="Chance a new tile is a 4 instead of a 2.")
    slide_seconds: float = field(0.2, unit="s", doc="How long a slide takes to settle (ease-out).")
    milestone: int = field(128, doc="Forging a new highest tile at least this big rings and shakes.")
    shake: float = field(0.08)
    shake_per_value: float = field(0.00004)
    shake_max: float = field(0.35)
    shake_seconds: float = field(0.16, unit="s")

