"""Content registries: the horde, the escalation curve, the upgrade deck, the shrine's
perks and the arena's dressing."""

from enum import Enum

from parallax import ContentRef, Localized, PrefabRef, content, field, record


@record
class Effect:
    """A bag of stat changes. Draft upgrades and shrine perks both speak it."""
    damage_add: float = field(0)
    fire_interval_mul: float = field(1)
    bolts_add: int = field(0)
    pierce_add: int = field(0)
    hit_radius_add: float = field(0, unit="m")
    speed_mul: float = field(1)
    pickup_add: float = field(0, unit="m")
    max_health_add: float = field(0)
    heal_pct: float = field(0)
    nova_cooldown_mul: float = field(1)
    nova_radius_add: float = field(0, unit="m")
    nova_damage_add: float = field(0)
    xp_mul: float = field(1)
    aura_dps_add: float = field(0)
    aura_radius_add: float = field(0, unit="m")
    lifesteal_add: float = field(0)
    mercy_add: float = field(0, unit="s")
    revive_add: int = field(0)
    reroll_add: int = field(0)


class Tier(Enum):
    COMMON = "common"
    RARE = "rare"


@content("enemy")
class EnemyDef:
    """One kind of horde member: its stats, what it pays, and what it bursts into."""
    name: Localized
    prefab: PrefabRef
    hp: float = field(min=1)
    damage: float = field(doc="Per bite.")
    move_speed: float = field(unit="m/s")
    xp: float = field(1, doc="What its soul mote is worth.")
    score: float = field(10)
    heart_chance: float = field(0, min=0, max=1)
    split_into: ContentRef["EnemyDef"] | None = field(None, doc="Bursts into these when it dies.")
    split_count: int = field(0)
    split_spread: float = field(1.6, unit="m")


@content("surge", order="at_second")
class SurgeDef:
    """A time tier. From `at_second` on, a surge of `groups` boils out every `interval`."""
    name: Localized
    at_second: float = field(unit="s")
    interval: float = field(unit="s")
    hp_scale: float = field(1)
    speed_scale: float = field(1)
    groups: dict[ContentRef[EnemyDef], int] = field()


@content("entrance")
class EntranceDef:
    """A scripted elite arrival, announced with its own banner."""
    alert: Localized
    enemy: ContentRef[EnemyDef]
    at_second: float = field(unit="s")
    count: int = field(1)
    hp_scale: float = field(1)


@content("upgrade")
class UpgradeDef:
    """A level-up draft card, drawn by weight until taken `max_stacks` times."""
    name: Localized
    desc: Localized
    icon: str = field()
    tier: Tier = field(Tier.COMMON)
    weight: float = field(1, min=0)
    max_stacks: int = field(1, min=1)
    effect: Effect = field()


@content("perk", order="order")
class PerkDef:
    """A permanent shrine perk, bought with ember dust and applied `level` times at run start."""
    order: int = field(doc="Its place on the shrine.")
    name: Localized
    desc: Localized
    cost: int = field()
    cost_step: int = field(doc="Each level costs this much more than the last.")
    max_level: int = field()
    effect: Effect = field()


@content("decor")
class DecorDef:
    """One layer of the seeded arena: scattered pieces thinned by a noise field in -1..1.
    Below `threshold` nothing stands; above it a piece stays with odds
    `(field - threshold) * gain`, so drifts thicken toward their hearts."""
    prefab: PrefabRef
    count: int = field(doc="Pieces scattered before thinning.")
    min_spacing: float = field(unit="m")
    radius: float = field(unit="m")
    clear_radius: float = field(unit="m", doc="Keep the centre open.")
    threshold: float = field(0, min=-1, max=1, doc="Only where the field is hotter than this.")
    gain: float = field(1, min=0)
    ridged: bool = field(False, doc="Ridged veins instead of rolling drifts.")
    frequency: float = field(0.02)
    octaves: int = field(3)
    scale_variance: float = field(0, min=0, max=1)
