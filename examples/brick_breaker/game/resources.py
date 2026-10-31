"""Game-wide state. Everything resets on retry (`new_run=True`) except `Best`."""

from parallax import ContentRef, field, resource

from game.content import UpgradeDef


@resource("run")
class Run:
    stage_index: int = field(0, min=0)
    score: int = field(0, min=0)
    combo: int = field(0, min=0, doc="Bricks hit since the orb last left the paddle.")
    balls_lost: int = field(0, min=0)
    bricks_left: int = field(0, min=0)
    serving: bool = field(True, doc="The orb is resting on the paddle, waiting to launch.")
    won: bool = field(False)
    new_best: bool = field(False)


@resource("mods")
class Mods:
    """The stacked effect of every upgrade drafted this run. Run-wide multipliers
    that the paddle, the orb and scoring each read."""
    paddle_width: float = field(1.0)
    paddle_speed: float = field(1.0)
    english: float = field(1.0)
    ball_accel: float = field(1.0)
    ball_slow: float = field(1.0)
    score_mult: float = field(1.0)
    extra_lives: int = field(0)


@resource("draft")
class Draft:
    offer: list[ContentRef[UpgradeDef]] = field([], doc="Non-empty exactly while drafting.")
    owned: list[ContentRef[UpgradeDef]] = field([])


@resource("best", keep="profile")
class Best:
    score: int = field(0)
