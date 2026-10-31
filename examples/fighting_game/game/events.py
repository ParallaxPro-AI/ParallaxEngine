"""Everything that happens in a fight, as typed messages."""

from parallax import ContentRef, Entity, event

from game.components import Corner
from game.content import MoveDef


@event("bout_started")
class BoutStarted:
    stage: int


@event("round_ended")
class RoundEnded:
    winner: Corner | None
    """None is a draw."""


@event("bout_ended")
class BoutEnded:
    stage: int
    won: bool


@event("run_ended")
class RunEnded:
    won: bool


@event("strike_landed", target="defender")
class StrikeLanded:
    """A hitbox or bolt touched the other fighter; the exchange decides what it means."""
    attacker: Entity
    defender: Entity
    move: ContentRef[MoveDef]


@event("exchange_resolved")
class ExchangeResolved:
    attacker: Entity
    defender: Entity
    move: ContentRef[MoveDef]
    blocked: bool
    punish: bool
    damage: float


@event("whiffed", target="entity")
class Whiffed:
    entity: Entity
    move: ContentRef[MoveDef]


@event("lesson_passed")
class LessonPassed:
    lesson: int
