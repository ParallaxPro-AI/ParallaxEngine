"""Things the player does or has happen to them."""

from parallax import ContentRef, Entity, Vec3, event

from features.on_foot.content import WeaponDef
from features.on_foot.resources import Setback


@event("weapon_fired")
class WeaponFired:
    by: Entity
    weapon: ContentRef[WeaponDef]
    at: Vec3


@event("player_recovered")
class PlayerRecovered:
    kind: Setback
