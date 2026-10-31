"""What happens to the hero."""

from parallax import Entity, event


@event("xp_gained")
class XpGained:
    amount: int


@event("levelled_up")
class LevelledUp:
    level: int


@event("hero_respawned")
class HeroRespawned:
    hero: Entity
