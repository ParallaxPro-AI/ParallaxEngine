"""Events shared across features."""

from parallax import Entity, event


@event("used", target="entity")
class Used:
    """The player pressed use on this entity (a chest, a bed, a grave, a door's block)."""
    entity: Entity
    by: Entity
