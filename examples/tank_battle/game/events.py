"""Events."""

from parallax import Entity, event


@event("ammo_resupplied", target="tank")
class AmmoResupplied:
    tank: Entity


@event("drum_lit", target="drum")
class DrumLit:
    """A shell burst next to this fuel drum."""
    drum: Entity
    by: Entity | None
