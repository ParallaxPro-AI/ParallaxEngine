"""Game-wide state. Everything resets on retry except `Pace` (this session) and `Best`
(this device)."""

from enum import Enum

from parallax import Timer, field, resource
from parallax.values import Cell


class Mode(Enum):
    """What a Stalker is doing. The shared clock only ever holds SCATTER or CHASE."""
    SCATTER = "scatter"
    CHASE = "chase"
    FRIGHTENED = "frightened"
    EATEN = "eaten"


@resource("run")
class Run:
    level_index: int = field(0, min=0)
    score: int = field(0, min=0)
    lives_lost: int = field(0, min=0)
    won: bool = field(False)
    new_best: bool = field(False)


@resource("board")
class Board:
    """The current level's maze."""
    pips_left: int = field(0, min=0)
    door: Cell = field(Cell(0, 0), doc="Where eaten Stalkers revive.")
    ready: Timer = field(Timer.cooldown(0), doc="The READY freeze; nothing moves until it's done.")
    clock: float = field(0.0, unit="s", doc="Seconds of actual play on this level.")


@resource("hunt")
class Hunt:
    """The clock all four Stalkers share. Reset at the start of every round."""
    phase: Mode = field(Mode.SCATTER, choices=(Mode.SCATTER, Mode.CHASE))
    phase_timer: Timer = field(Timer.cooldown(0))
    fright: Timer = field(Timer.cooldown(0), doc="Running while the Stalkers are edible.")
    chain: int = field(0, min=0, doc="Stalkers eaten on the current flare.")


@resource("pace", keep="session")
class Pace:
    """Adaptive difficulty. Survives retries on purpose (a retry after a loss should be
    gentler), but not restarting the game."""
    level: float = field(0.5, min=0, max=1, doc="What the knobs read; eases toward `target`.")
    target: float = field(0.5, min=0, max=1, doc="Where the nudges and the drift put the pace.")


@resource("best", keep="profile")
class Best:
    score: int = field(0)
    level: int = field(0, doc="Deepest level reached (1-based).")
