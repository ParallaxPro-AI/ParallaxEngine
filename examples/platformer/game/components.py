"""Per-entity data, tags, and the scene tag every level carries."""

from parallax import ContentRef, component, field, tag

from game.content import CollectibleDef, EnemyDef

Level = tag("level")
"""Scene tag: `"tags": ["level"]` in each level's scene.json. Level systems,
the pause menu and the controls are scoped with `scenes=[Level]`."""

Player = tag("player")
SafeGround = tag("safe_ground")
Hazard = tag("hazard")
Goal = tag("goal")
Checkpoint = tag("checkpoint")


@component("collectible")
class Collectible:
    kind: ContentRef[CollectibleDef] = field()


@component("enemy")
class Enemy:
    kind: ContentRef[EnemyDef] = field()


def player_touches(kind):
    """`@on(TriggerEntered, where=player_touches(Goal))`: the player walked into
    a trigger that has this tag or component."""
    return lambda event: event.entity.has(kind) and event.target.has(Player)


VaultBridge = tag("vault_bridge")
"""The Lantern Hollows crystal bridge: hidden below the level until both plates are lit."""


@component("crystal_plate")
class CrystalPlate:
    """A pressure plate. The first step lights it for good (its `glow` child shows)."""

    lit: bool = field(False)
