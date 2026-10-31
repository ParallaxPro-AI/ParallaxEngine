"""Events. Your baller and the bots ask for shots, passes and steals with the same events,
so the rules that resolve them never know who is human."""

from enum import Enum

from parallax import Entity, Tag, event


class Zone(Enum):
    GREEN = "green"
    YELLOW = "yellow"
    MISS = "miss"


@event("shot_released", target="shooter")
class ShotReleased:
    shooter: Entity
    zone: Zone
    """Where the meter stopped (bots roll for it)."""


@event("pass_attempted")
class PassAttempted:
    passer: Entity


@event("steal_attempted")
class StealAttempted:
    by: Entity


@event("bucket_scored")
class BucketScored:
    shooter: Entity
    points: int
    assist: Entity | None
    contested: bool


@event("bucket_incoming", target="shooter")
class BucketIncoming:
    """A clutch make is in the air (decided at release): a contested make, any make in
    overtime, or one in the final quarter with the game within six."""
    shooter: Entity


@event("shot_missed")
class ShotMissed:
    shooter: Entity


@event("ball_stolen")
class BallStolen:
    by: Entity
    victim: Entity


@event("rebound_claimed")
class ReboundClaimed:
    by: Entity


@event("shot_clock_expired")
class ShotClockExpired:
    team: Tag
    """The team that was holding the ball."""


@event("period_started")
class PeriodStarted:
    quarter: int
    inbound: Tag
    """The team that takes the ball out."""


@event("period_ended")
class PeriodEnded:
    quarter: int


@event("game_decided")
class GameDecided:
    won: bool
