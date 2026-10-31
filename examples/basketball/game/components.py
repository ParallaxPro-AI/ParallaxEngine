"""Per-entity data: the ball, the ballers and the hoops.

Fields marked `modifiable` are the ones locker-room perks stack on."""

from enum import Enum

from parallax import Entity, Tag, Vec3, component, field, tag

from game.content import BotStyle

Home = tag("home")
"""You and your AI running mate."""

Away = tag("away")
"""The crew you're playing tonight."""

You = tag("you")
"""The baller you control."""


class Throw(Enum):
    PASS = "pass"
    SHOT = "shot"


@component("ball")
class Ball:
    """Possession. The ball is held, in the air (it has a Flight), or loose on the floor."""

    holder: Entity | None = field(None)
    shot_clock: float = field(0, unit="s", doc="Reset on every change of possession and every shot.")
    rest: Vec3 = field(Vec3.ZERO, doc="Where a loose ball lies.")
    loose_for: float = field(0, unit="s", doc="Scramble time left before the nearest player is given it.")
    boxed_out: Entity | None = field(None, doc="A bot that just missed and can't take its own rebound.")
    boxed_out_for: float = field(0, unit="s")
    passer: Entity | None = field(None, doc="Who threw the last completed pass (for assists).")
    caught_at: float = field(0, unit="s", doc="Game time that pass was caught.")
    pass_speed: float = field(18, unit="m/s", modifiable=True, doc="How fast every pass travels.")


@component("flight")
class Flight:
    """The ball in the air. A shot's result is decided at release; the flight is the suspense."""

    kind: Throw = field(Throw.PASS)
    thrower: Entity = field()
    receiver: Entity | None = field(None, doc="Pass target.")
    start: Vec3 = field(Vec3.ZERO)
    end: Vec3 = field(Vec3.ZERO)
    elapsed: float = field(0, unit="s")
    duration: float = field(1, unit="s")
    made: bool = field(False)
    points: int = field(0)
    contested: bool = field(False)
    assist: Entity | None = field(None)


@component("hoop")
class Hoop:
    defended_by: Tag = field()
    rim_height: float = field(3.05, unit="m")


@component("bot")
class Bot:
    """A baller the AI plays: your running mate and both of tonight's crew."""

    style: BotStyle = field(BotStyle())
    steal_ready_in: float = field(0, unit="s")


@component("edge")
class Edge:
    """A baller's bonuses on top of the court's rules. Zero for everyone until perks
    stack on them, so every rule adds them without asking whose they are."""

    make_bonus: float = field(0, modifiable=True, doc="Added to the make rate of every shot.")
    three_bonus: float = field(0, modifiable=True, doc="Added to the make rate of threes.")
    clutch_bonus: float = field(0, modifiable=True, doc="Added to the make rate late in a period.")
    contest_relief: float = field(0, modifiable=True, doc="Added to the contested multiplier.")
    steal_chance: float = field(0, modifiable=True)
    steal_range: float = field(0, unit="m", modifiable=True)
    steal_cooldown: float = field(0, unit="s", modifiable=True)
    pickup_radius: float = field(0, unit="m", modifiable=True, doc="Extra reach on loose balls.")


@component("meter")
class Meter:
    """Your shot meter: the needle and the windows a release is judged against."""

    charging: bool = field(False)
    needle: float = field(0, min=0, max=1)
    green_low: float = field(0.72, min=0, max=1, modifiable=True)
    green_high: float = field(0.95, min=0, max=1, modifiable=True)
    yellow_low: float = field(0.5, min=0, max=1)
    yellow_high: float = field(0.98, min=0, max=1)


@component("stamina")
class Stamina:
    current: float = field(100, min=0)
    max: float = field(100, min=1, modifiable=True)
    drain: float = field(26, unit="1/s")
    regen: float = field(16, unit="1/s", modifiable=True)
    floor: float = field(0.08, min=0, max=1, doc="Can't start a sprint below this fraction of the tank.")


@component("box_score")
class BoxScore:
    """A baller's line for the whole run."""

    points: int = field(0)
    attempts: int = field(0)
    made: int = field(0)
    greens: int = field(0)
    assists: int = field(0)
    rebounds: int = field(0)
    steals: int = field(0)
