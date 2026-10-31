from parallax import Entity, event


@event("home_set", target="by")
class HomeSet:
    by: Entity


@event("slept")
class Slept:
    """`by` slept through to the next morning."""
    by: Entity
