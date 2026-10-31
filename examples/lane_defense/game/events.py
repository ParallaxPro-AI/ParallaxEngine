"""Events."""

from parallax import Entity, Vec3, event


@event("pollen_collected")
class PollenCollected:
    amount: int
    at: Vec3


@event("husk_reached_house", target="husk")
class HuskReachedHouse:
    husk: Entity
