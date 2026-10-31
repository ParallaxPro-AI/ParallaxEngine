"""Per-entity data: rooms, gates, foes, projectiles and the things lying on the floor."""

from parallax import ContentRef, Entity, Vec3, component, field, tag
from parallax.physics import Layers as PhysicsLayers, layer

from game.content import EnemyDef, ItemDef, RoomKindDef

Keeper = tag("keeper")
Keepers = tag("side_keepers")
Cellar = tag("side_cellar")
Breakable = tag("breakable")


class Layers(PhysicsLayers):
    keeper = layer()
    foe = layer()
    wall = layer()
    prop = layer()
    shard = layer()
    spit = layer()
    pickup = layer()


@component("room")
class Room:
    kind: ContentRef[RoomKindDef] = field()
    cell_x: int = field(0)
    cell_y: int = field(0)
    visited: bool = field(False)
    fighting: bool = field(False)
    cleared: bool = field(False)


@component("gate")
class Gate:
    """A door between two rooms. Shut while it's locked or either room is fighting."""
    between: list[Entity] = field()
    locked: bool = field(False)
    lock: int = field(-1, doc="Which key opens it (0 = the boss key); -1 = never locked.")


@component("key_for")
class KeyFor:
    """A gate key lying on the floor: it opens every gate with this lock number."""
    lock: int = field(0)


@component("foe")
class Foe:
    kind: ContentRef[EnemyDef] = field()
    room: Entity = field()
    contact_damage: int = field(1, doc="Half-hearts.")
    elite: bool = field(False)
    master: Entity | None = field(None, doc="The boss that summoned it; it dies with them.")


@component("projectile")
class Projectile:
    velocity: Vec3 = field()
    damage: float = field()
    lifetime: float = field(unit="s")


@component("pickup")
class Pickup:
    item: ContentRef[ItemDef] = field()


@component("shop_item")
class ShopItem:
    item: ContentRef[ItemDef] = field()
    price: int = field()
