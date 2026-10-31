"""Content registries: the stages of the gauntlet and the upgrade pool. Names and
taglines are written inline in each entry's JSON."""

from parallax import Color, Localized, content, field


@content("stage", order="number")
class StageDef:
    """One wall of prism bricks. Each string in `rows` is a row of cells from the top:
    "." is empty, a digit is a brick with that many hit points."""
    number: int = field(min=1, doc="Position in the gauntlet.")
    name: Localized = field()
    tagline: Localized = field()
    color: Color = field(doc="Signature colour: tints the rails, the bricks and the sparks.")
    ball_speed_scale: float = field(1.0, min=0.1)
    rows: list[str] = field()


@content("upgrade")
class UpgradeDef:
    """A between-stage upgrade. Multipliers stack for the rest of the run."""
    name: Localized = field()
    description: Localized = field()
    paddle_width: float = field(1.0, min=0.1)
    paddle_speed: float = field(1.0, min=0.1)
    english: float = field(1.0, min=0.1)
    ball_accel: float = field(1.0, min=0)
    ball_slow: float = field(1.0, min=0.1)
    score_mult: float = field(1.0, min=0.1)
    extra_lives: int = field(0, min=0)
