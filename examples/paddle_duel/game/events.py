"""Events: what happens on the court. Menu buttons need none (see `game/ui.py`)."""

from parallax import ContentRef, Entity, Vec3, event

from game.content import PerkDef


@event("perk_picked")
class PerkPicked:
    perk: ContentRef[PerkDef]


@event("duel_started")
class DuelStarted:
    index: int


@event("ball_served")
class BallServed: ...


@event("ball_returned")
class BallReturned:
    source: Entity
    smashed: bool


@event("wall_hit")
class WallHit:
    at: Vec3


@event("rally_ended")
class RallyEnded:
    """The ball reached the goal at `at`. A refunded point (Second Wind) scores for nobody."""
    player_scored: bool
    refunded: bool
    at: Vec3


@event("duel_won")
class DuelWon:
    final: bool


@event("duel_lost")
class DuelLost: ...


@event("run_ended")
class RunEnded:
    won: bool
