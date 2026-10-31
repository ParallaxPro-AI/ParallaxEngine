"""Game-wide tunables, read from config/rules.json."""

from parallax import config, field


@config("rules")
class Rules:
    """Lives, scoring and the draft. Stage layouts are content; brick spacing is the
    wall's `Grid` in the arena scene."""
    lives: int = field(3, min=1)
    brick_score: int = field(100, min=0)
    combo_score: int = field(25, min=0, doc="Extra points per brick already hit this rally.")
    clear_bonus: int = field(500, min=0)
    draft_size: int = field(3, min=1)
    rail_shade: float = field(0.3, min=0, max=1, doc="How much darker the rails are than the stage colour.")
