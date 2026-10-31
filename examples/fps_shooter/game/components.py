"""Per-entity data and tags."""

from parallax import ContentRef, Entity, Vec3, component, field, tag

from game.content import BotDef, WeaponDef

Player = tag("player")
SpawnPoint = tag("spawn_point")
Humans = tag("humans")
"""Side of the player."""
Bots = tag("bots")
"""Side of every bot (bots don't shoot each other)."""


@component("arsenal")
class Arsenal:
    """The player's guns and ammo (the HUD shows it; pickups and upgrades refill it)."""

    weapons: list[ContentRef[WeaponDef]] = field([])
    current: int = field(0)
    loaded: dict[ContentRef[WeaponDef], int] = field({}, doc="Rounds in each magazine.")
    reserve: dict[ContentRef[WeaponDef], int] = field({}, doc="Spare rounds per weapon.")
    reload_done_at: float = field(-1, unit="s", doc="-1 when not reloading.")
    zoomed: bool = field(False)


@component("plating")
class Plating:
    """Armor points. While any remain, they soak up part of every hit (see damage.py)."""

    points: float = field(0, min=0)


@component("fighter")
class Fighter:
    """A name on the scoreboard."""

    name: str = field("")


@component("bot")
class Bot:
    """A bot's archetype."""

    kind: ContentRef[BotDef] = field()


@component("cover_spot")
class CoverSpot:
    """A hiding place behind cover, and the spot beside it to peek and shoot from.
    One bot at a time may use it."""

    peek: Vec3 = field(Vec3.ZERO)
    taken_by: Entity | None = field(None)


@component("smoke_cloud")
class SmokeCloud:
    """A smoke grenade's cloud: a sphere no bot can see or shoot through until it clears."""

    radius: float = field(3, unit="m")
    clears_at: float = field(0, unit="s")
