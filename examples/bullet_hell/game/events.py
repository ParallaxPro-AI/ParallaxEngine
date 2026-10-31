"""Events: the campaign, then the Wisp. Menu buttons need none (see `game/ui.py`)."""

from parallax import ContentRef, Entity, event

from game.content import BloomDef, UpgradeDef


@event("upgrade_picked")
class UpgradePicked:
    upgrade: ContentRef[UpgradeDef]


@event("wave_started")
class WaveStarted:
    index: int
    boss: bool


@event("wave_cleared")
class WaveCleared:
    index: int
    final: bool


@event("guardian_escaped")
class GuardianEscaped:
    """A guardian slipped past the bottom of the field."""


@event("grazed", target="wisp")
class Grazed:
    wisp: Entity


@event("bomb_requested", target="wisp")
class BombRequested:
    wisp: Entity


@event("bloom_collected", target="wisp")
class BloomCollected:
    wisp: Entity
    bloom: ContentRef[BloomDef]


@event("shield_broken")
class ShieldBroken:
    """A hit spent a dewshield instead of a petal."""


@event("wisp_hurt")
class WispHurt:
    """A hit cost a petal."""


@event("bomb_bloomed")
class BombBloomed: ...


@event("spirit_bloomed")
class SpiritBloomed:
    """A full Spirit meter turned into a bomb."""


@event("bombs_empty")
class BombsEmpty: ...


@event("run_ended")
class RunEnded:
    won: bool
