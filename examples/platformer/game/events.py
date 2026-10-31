"""Events the levels emit.

Menu buttons are panel commands or plain functions (see `game/ui.py`), so none
of them needs an event."""

from enum import Enum

from parallax import ContentRef, Entity, PrefabRef, Vec3, event

from game.content import LevelDef


class DeathCause(Enum):
    FELL = "fell"
    HAZARD = "hazard"
    ENEMY = "enemy"


@event("player_died")
class PlayerDied:
    cause: DeathCause


@event("respawned", target="entity")
class Respawned:
    entity: Entity
    at: Vec3


@event("crumbled")
class Crumbled:
    """A crumble block gave way; it comes back after a while."""

    prefab: PrefabRef
    at: Vec3


@event("level_finished")
class LevelFinished:
    level: ContentRef[LevelDef]
    won: bool
