from parallax import config, field


@config("rules")
class Rules:
    """The opponent's one knob, the result points and the pacing."""
    mistake_chance: float = field(min=0, max=1, doc="Chance per move of a random cell instead of the best one. 0 never loses.")
    win_points: int = field(min=0)
    draw_points: int = field(min=0)
    think_seconds: float = field(min=0, unit="s")
    banner_seconds: float = field(min=0, unit="s", doc="How long the opening banner shows.")
