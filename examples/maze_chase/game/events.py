"""Events: what happens in the maze. Menu buttons need none (see `game/ui.py`)."""

from parallax import Entity, Vec3, event


@event("round_started")
class RoundStarted:
    """Everyone back to their start cell for the READY freeze: a new level, or after a catch."""


@event("pip_eaten")
class PipEaten:
    flare: bool
    at: Vec3


@event("stalker_eaten")
class StalkerEaten:
    stalker: Entity
    chain: int
    """1 for the first Stalker eaten on this flare, 2 for the second…"""


@event("gobbler_caught")
class GobblerCaught: ...


@event("level_cleared")
class LevelCleared:
    final: bool
    seconds: float


@event("run_ended")
class RunEnded:
    won: bool
