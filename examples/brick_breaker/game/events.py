"""Events: what happens on the board. Menu buttons need none (see `game/ui.py`)."""

from parallax import ContentRef, Vec3, event

from game.content import UpgradeDef


@event("upgrade_picked")
class UpgradePicked:
    upgrade: ContentRef[UpgradeDef]


@event("stage_started")
class StageStarted:
    index: int


@event("stage_cleared")
class StageCleared:
    final: bool


@event("ball_launched")
class BallLaunched: ...


@event("ball_returned")
class BallReturned:
    """The orb came off the paddle."""
    at: Vec3


@event("rail_hit")
class RailHit:
    at: Vec3


@event("ball_lost")
class BallLost:
    at: Vec3


@event("run_ended")
class RunEnded:
    won: bool
