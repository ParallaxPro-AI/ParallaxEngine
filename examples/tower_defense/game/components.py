"""Per-entity data and tags."""

from parallax import ContentRef, Entity, Vec3, component, field, tag

from game.content import EnemyDef, TowerDef

BattlefieldScene = tag("battlefield")
"""Scene tag of the four battlefields: where building, waves, the purse and pause exist."""
BuildPad = tag("build_pad")
"""A spot a tower can stand on. A built tower is the pad's child."""
Defenders = tag("defenders")
Horde = tag("horde")
Tower = tag("tower")
"""Every built tower (tower_arrow, tower_cannon, ...)."""
Poison = tag("poison")
"""Damage kind of venom ticks (content/status_effect/venom.json); armor doesn't stop it."""


@component("route")
class Route:
    """The road the horde walks, entrance to keep. One per battlefield scene."""

    points: list[Vec3] = field([])


@component("turret")
class Turret:
    """A built tower. Its numbers are `kind.data.levels[level - 1]` (see `stats`)."""

    kind: ContentRef[TowerDef] = field()
    level: int = field(1, min=1)


@component("invader")
class Invader:
    """An enemy on the road. `speed` is battlefield-scaled; chill slows it as a modifier."""

    kind: ContentRef[EnemyDef] = field()
    speed: float = field(0, unit="m/s", modifiable=True)


@component("shot")
class Shot:
    """A projectile in flight, and the tower level that fired it."""

    tower: ContentRef[TowerDef] = field()
    level: int = field(1, min=1)
    target: Entity = field()
