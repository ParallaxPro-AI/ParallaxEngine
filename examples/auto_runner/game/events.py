"""Events the run emits.

Menu buttons are panel commands or plain functions (see `game/ui.py` and
`game/profile.py`), so none of them needs an event."""

from parallax import ContentRef, Entity, event

from game.content import ObstacleDef, StageDef


@event("hazard_placed")
class HazardPlaced:
    kind: ContentRef[ObstacleDef]
    x: float
    gap: float
    lead_in: bool = False


@event("stage_entered")
class StageEntered:
    stage: ContentRef[StageDef]


@event("scrolled_off", target="entity")
class ScrolledOff:
    entity: Entity


@event("run_ended")
class RunEnded:
    won: bool
    killer: ContentRef[ObstacleDef] | None = None
