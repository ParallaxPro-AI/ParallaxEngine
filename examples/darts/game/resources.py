from enum import Enum

from parallax import ContentRef, Timer, field, record, resource
from project import Content

from game.content import ConditionDef, GradeDef, TierDef
from game.darts import Hit


class Stage(Enum):
    THROWING = "throwing"
    LEG_WON = "leg_won"
    """Checked out; the leg card is up (after a beat) until the next leg starts."""
    OVER = "over"


class Result(Enum):
    WON = "won"
    LOST = "lost"


@record
class LegResult:
    """One row of the scorecard."""
    number: int
    darts: int
    over_par: int
    grade: ContentRef[GradeDef]
    points: int


@resource("match", keep="scene")
class Match:
    """The nine-leg match in the hall. Lives for one load of the hall scene, so
    Play again is a plain scene load."""
    tier: ContentRef[TierDef] = field(Content.tier.steady_hand, doc="Latched when the match starts.")
    leg: int = field(0, doc="Index into the card (`ctx.content(LegDef)`).")
    stage: Stage = field(Stage.THROWING)
    remaining: int = field(0)
    darts: int = field(0, doc="Darts thrown this leg.")
    total_darts: int = field(0)
    score: int = field(0)
    last_hit: Hit | None = field(None, doc="This leg's latest dart, for the HUD.")
    card: list[LegResult] = field([])
    busts: int = field(0)
    bullseyes: int = field(0)
    maximums: int = field(0)
    result: Result | None = field(None)
    unlocked: ContentRef[TierDef] | None = field(None, doc="The tier this match opened, if any.")
    callout: str = field("", doc="The HUD's skill-shot / penalty toast text (the template's skillToast).")
    callout_points: int = field(0)
    callout_at: float = field(-100.0, unit="s", doc="Game time the callout went up; the HUD shows it for 1.6 s.")


@resource("air", keep="scene")
class Air:
    """The crosswind over the oche right now. Pushes the dart in flight, bends
    the aim line and drives the HUD dial."""
    condition: ContentRef[ConditionDef] = field(Content.condition.still)
    bearing: float = field(0.0, unit="deg", doc="0 blows toward the thrower's right (world -x), 180 toward their left.")
    speed: float = field(0.0, unit="m/s")
    leg_speed: float = field(0.0, unit="m/s", doc="The speed rolled for this leg; gusts drift around it.")
    next_gust: Timer = field(Timer.cooldown(0.0))


@resource("career", keep="profile")
class Career:
    """The player's Tour standing and records, kept between sessions."""
    tier: int = field(0, doc="Rank of the tier the player chose.")
    unlocked: int = field(0, doc="Highest rank opened so far.")
    best_score: int = field(0)
    best_over_par: int | None = field(None)
    matches: int = field(0)
    bullseyes: int = field(0)
