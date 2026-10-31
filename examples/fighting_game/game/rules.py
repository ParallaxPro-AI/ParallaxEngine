"""The circuit's rules (config/rules.json) and the lookups every module shares."""

from typing import Callable

from parallax import ContentRef, Context, config, field

from game.content import DifficultyDef, LessonDef, RivalDef
from game.resources import Match, Mode, Phase, Preferences


@config("rules")
class Rules:
    """The match shape and the SPIRIT economy."""
    ladder: list[ContentRef[RivalDef]]
    lessons: list[ContentRef[LessonDef]]
    difficulties: list[ContentRef[DifficultyDef]] = field(doc="Order the title screen cycles through.")
    frame_rate: int = field(60)
    rounds_to_win: int = field(2, min=1)
    round_seconds: float = field(60, unit="s")
    intro_seconds: float = field(1.8, unit="s")
    round_end_seconds: float = field(1.8, unit="s")
    start_x: float = field(2.5, unit="m", doc="Each fighter starts this far from the centre.")
    buffer_seconds: float = field(0.15, unit="s", doc="How long a pressed attack waits to come out.")
    meter_max: float = field(100)
    meter_on_hit: float = field(9)
    meter_on_take_hit: float = field(5)
    meter_on_block: float = field(4)
    chip_factor: float = field(0.12, doc="Fraction of damage a guarded hit still deals (never lethal).")
    armour_factor: float = field(0.5, doc="Fraction of damage an armoured move takes.")
    block_knockback: float = field(1.2, unit="m/s")
    block_hitstop: float = field(0.035, unit="s")
    shake_seconds: float = field(0.09, unit="s")
    pop_height: float = field(1.6, unit="m", doc="Hit pops rise from this far above the defender's feet.")
    callout_seconds: float = field(1.2, unit="s", doc="How long the HUD's centre call-out stays up.")
    lesson_walk_distance: float = field(1, unit="m")


def frames(ctx: Context, count: int) -> float:
    """Fighting-game frames → seconds."""
    return count / ctx.config(Rules).frame_rate


def current_rival(ctx: Context) -> RivalDef:
    return ctx.config(Rules).ladder[ctx.get(Match).stage].data


def current_lesson(ctx: Context) -> LessonDef:
    return ctx.config(Rules).lessons[ctx.get(Match).lesson].data


def difficulty(ctx: Context) -> DifficultyDef:
    return ctx.get(Preferences).difficulty.data


# Run conditions for `when=` on systems, behaviors and handlers.

def run_in_progress(ctx: Context) -> bool:
    """A run has been started (the title screen is not up)."""
    return ctx.get(Match).phase is not Phase.IDLE


def fighting(ctx: Context) -> bool:
    """A round is live: fighters may move, attack and be knocked out."""
    return ctx.get(Match).phase is Phase.FIGHT


def in_mode(mode: Mode) -> Callable[[Context], bool]:
    """The run being played is in `mode`."""
    return lambda ctx: ctx.get(Match).mode is mode


def fighting_in(mode: Mode) -> Callable[[Context], bool]:
    """A round of `mode` is live."""
    return lambda ctx: fighting(ctx) and ctx.get(Match).mode is mode
