"""Typed messages between the cellar's systems."""

from parallax import ContentRef, Entity, event

from game.content import ItemDef


@event("item_collected")
class ItemCollected:
    item: ContentRef[ItemDef]


@event("summon_requested")
class SummonRequested:
    master: Entity
    count: int


@event("floor_boss_cleared")
class FloorBossCleared:
    floor: int


@event("boss_slain")
class BossSlain:
    """Any floor's boss died (a vault record)."""


@event("run_won")
class RunWon:
    """The last floor's boss room was cleared."""


@event("descended")
class Descended:
    """The keeper stepped on the exit pad."""


@event("run_banked")
class RunBanked:
    coins: int
    won: bool
    floor: int
