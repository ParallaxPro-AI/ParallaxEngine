"""Events: what happens to the plane and the career. Title and office buttons are
plain panel actions (game/career_slot.py, game/office.py)."""

from parallax import Entity, event


@event("plane_lost", target="plane")
class PlaneLost:
    plane: Entity
    ditched: bool


@event("cargo_delivered")
class CargoDelivered:
    pay: int


@event("career_ended")
class CareerEnded:
    won: bool
