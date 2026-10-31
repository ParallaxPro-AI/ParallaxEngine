"""Game-wide tunables, read from config/rules.json."""

from parallax import config, field


@config("rules")
class Rules:
    """Duel length and run scoring. The rivals and their order are content."""
    win_score: int = field(5, min=1, doc="Points that win a duel.")
    point_score: int = field(100, min=0)
    rally_score: int = field(15, min=0, doc="Per player return, and again per return when the point is won.")
    duel_score: int = field(600, min=0)
    draft_size: int = field(3, min=1)
