"""Police events."""

from parallax import ContentRef, Entity, Vec3, event

from features.police.content import CrimeDef


@event("crime_committed")
class CrimeCommitted:
    crime: ContentRef[CrimeDef]
    at: Vec3


@event("player_busted")
class PlayerBusted:
    by: Entity
