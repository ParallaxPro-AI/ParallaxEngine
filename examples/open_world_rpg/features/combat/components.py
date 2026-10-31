"""Per-entity combat data."""

from parallax import ContentRef, Entity, Tag, Timer, component, field

from features.combat.content import AbilityDef
from features.combat.tags import Physical
from features.inventory.feature import GearDef, LootTableDef


@component("offense")
class Offense:
    """What the hero's sword does right now. Derived every frame by the loadout system."""

    damage: float = field(28, min=0)
    attack_rate: float = field(1.6, min=0.2, unit="swings/s")
    element: Tag = field(Physical)


@component("affinity")
class Affinity:
    """Damage taken per damage kind; kinds not listed take 1×. Applied by the `weakness` damage modifier."""

    multipliers: dict[Tag, float] = field({})


@component("threat")
class Threat:
    """Who an enemy is fighting. A taunt (Ember's bite) pulls it off the hero until `taunt` runs out."""

    engaged: bool = field(False)
    taunter: Entity | None = field(None)
    taunt: Timer = field(Timer.cooldown(0))


@component("spellbook")
class Spellbook:
    """Abilities the hero has learned and how long each has left to recharge."""

    known: list[ContentRef[AbilityDef]] = field([])
    cooldowns: dict[ContentRef[AbilityDef], float] = field({})


@component("bounty")
class Bounty:
    """What killing this enemy pays: gold, experience, a loot roll, and the next piece of gear not yet owned."""

    gold_min: int = field(0, min=0)
    gold_max: int = field(0, min=0)
    xp: int = field(0, min=0)
    loot: ContentRef[LootTableDef] | None = field(None)
    gear: list[ContentRef[GearDef]] = field([], doc="Walked in order; the first unowned piece drops.")
    gear_chance: float = field(1, min=0, max=1)
