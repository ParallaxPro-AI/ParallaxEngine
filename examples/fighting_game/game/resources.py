"""Game-wide state: the match in progress, this run's numbers, and the player's career."""

from enum import Enum

from parallax import ContentRef, Timer, field, resource
from project import Content

from game.components import Corner
from game.content import DifficultyDef


class Mode(Enum):
    CIRCUIT = "circuit"
    TRAINING = "training"
    PRACTICE = "practice"


class Phase(Enum):
    IDLE = "idle"
    """On the title screen."""
    INTRO = "intro"
    FIGHT = "fight"
    ROUND_OVER = "round_over"
    OVER = "over"
    """The run is decided; the result screen is up."""


BOUT_PHASES = (Phase.INTRO, Phase.FIGHT, Phase.ROUND_OVER)


class Dummy(Enum):
    """What the practice dummy does."""
    IDLE = "idle"
    GUARD = "guard"
    SPAR = "spar"


class CalloutStyle(Enum):
    """How the HUD's centre call-out is drawn."""
    GOLD = "gold"
    """PUNISH."""
    CYAN = "cyan"
    """A super's name."""
    WARN = "warn"
    """Something the player can't do yet (SUPER NEEDS 50 SPIRIT)."""
    LESSON = "lesson"
    """A passed training lesson: the cyan tick toast."""


@resource("match")
class Match:
    mode: Mode = field(Mode.CIRCUIT)
    phase: Phase = field(Phase.IDLE)
    phase_timer: Timer = field(Timer.cooldown(0), doc="Counts down the intro and the pause after a round.")
    stage: int = field(0, min=0, doc="Index into Rules.ladder.")
    round: int = field(1, min=1)
    clock: float = field(0, unit="s")
    challenger_wins: int = field(0)
    rival_wins: int = field(0)
    round_winner: Corner | None = field(None, doc="Who took the round just ended (None: a draw).")
    timed_out: bool = field(False, doc="The round just ended on the clock.")
    lesson: int = field(0, doc="Index into Rules.lessons (training).")
    dummy: Dummy = field(Dummy.IDLE)


@resource("callout")
class Callout:
    """The HUD's centre call-out (PUNISH, a super's name, a lesson passed), shown until `until`."""
    text: str = field("")
    style: CalloutStyle = field(CalloutStyle.GOLD)
    until: float = field(0, unit="s", doc="Game time the call-out disappears.")


@resource("run_stats")
class RunStats:
    """What the result screen reports about the run just played."""
    hits: int = field(0)
    blocks: int = field(0)
    punishes: int = field(0)
    best_combo: int = field(0)
    whiffs: int = field(0)
    won: bool = field(False)


@resource("career", keep="profile")
class Career:
    bouts: int = field(0)
    wins: int = field(0)
    best_challenger: int = field(0, doc="Furthest rung reached (1-based).")
    belts: int = field(0)
    perfect_rounds: int = field(0)
    training_done: bool = field(False)
    checkpoint: int = field(-1, doc="Ladder rung to continue from; -1 = none.")


@resource("preferences", keep="profile")
class Preferences:
    """The moves panel's own options (camera shake and sound are the engine's Settings)."""
    difficulty: ContentRef[DifficultyDef] = field(Content.difficulty.standard)
    haptics: bool = field(True)
    champion_kit: bool = field(False, doc="Wear the amber champion kit (once a belt is won).")
