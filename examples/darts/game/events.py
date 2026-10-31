from parallax import ContentRef, Vec2, Vec3, event, field

from game.content import GradeDef, LegDef, PenaltyDef, SkillDef
from game.darts import Hit, Outcome


@event("leg_started")
class LegStarted:
    leg: ContentRef[LegDef]


@event("dart_thrown")
class DartThrown:
    power: float
    clean: bool


@event("dart_landed")
class DartLanded:
    """The dart reached the board plane, or fell short / flew off."""
    at: Vec3
    offset: Vec2 | None = field(None, doc="From the bull on the board face; None if it never reached the board.")
    clean: bool = field(False)


@event("dart_scored")
class DartScored:
    hit: Hit
    outcome: Outcome
    penalty: ContentRef[PenaltyDef] | None = field(None)
    points: int = field(0)


@event("skills_scored")
class SkillsScored:
    skills: list[ContentRef[SkillDef]]
    points: int


@event("leg_won")
class LegWon:
    grade: ContentRef[GradeDef]
    points: int


@event("match_ended")
class MatchEnded:
    won: bool
