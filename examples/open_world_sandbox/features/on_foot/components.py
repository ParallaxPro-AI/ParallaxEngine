"""Per-entity data for people who fight."""

from parallax import ContentRef, component, field

from features.on_foot.content import WeaponDef


@component("armour")
class Armour:
    """How much a full vest holds. The vest itself is the combat plugin's `Health.shield`, which soaks
    every hit before health does until it runs out."""

    capacity: float = field(100, min=0)


@component("arsenal")
class Arsenal:
    """Weapons carried, the one in hand, and ammunition per weapon."""

    owned: list[ContentRef[WeaponDef]] = field([])
    current: ContentRef[WeaponDef] = field()
    loaded: dict[ContentRef[WeaponDef], int] = field({}, doc="Rounds in the magazine.")
    reserve: dict[ContentRef[WeaponDef], int] = field({}, doc="Rounds carried for reloading.")


@component("weapon_pickup")
class WeaponPickup:
    """Walk into it: a weapon (with its first reserve), loose ammo for the weapon in hand, or armour."""

    weapon: ContentRef[WeaponDef] | None = field(None)
    ammo: int = field(0, min=0)
    armour: bool = field(False)
