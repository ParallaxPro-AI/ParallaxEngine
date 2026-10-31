"""Events: what happened on the pitch, and how the cup moves on from it."""

from enum import Enum

from parallax import Entity, Tag, event


class Strike(Enum):
    SHOT = "shot"
    PASS = "pass"
    CLEARANCE = "clearance"


@event("ball_struck")
class BallStruck:
    by: Entity
    kind: Strike


@event("possession_won", target="by")
class PossessionWon:
    by: Entity
    previous: Entity | None
    """The player it was won from; None for a loose ball."""


@event("keeper_saved", target="keeper")
class KeeperSaved:
    keeper: Entity


@event("goal_scored")
class GoalScored:
    team: Tag
    goal: Entity


@event("tie_decided")
class TieDecided:
    won: bool


@event("round_started")
class RoundStarted:
    round: int
