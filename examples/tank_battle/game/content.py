"""Content registries: enemy tank tiers, waves, battlefields and field upgrades."""

from enum import Enum

from parallax import ContentRef, Localized, PrefabRef, SceneRef, content, field, record


class Role(Enum):
    FLANKER = "flanker"
    BRAWLER = "brawler"
    SNIPER = "sniper"
    BOSS = "boss"


@record
class BossPhase:
    """A boss changes tactics once its health falls to `at_health` (fraction)."""

    at_health: float = field(min=0, max=1)
    name: Localized
    speed_mul: float = field(1)
    fire_interval_mul: float = field(1)
    salvo: int = field(1, min=1)
    spread: float = field(2.86, unit="deg")


@content("enemy_tank")
class EnemyTankDef:
    """An enemy tier. `role` decides how it fights, not just how much it can take."""

    name: Localized
    prefab: PrefabRef
    role: Role
    health: float = field(min=1)
    armor: float = field(min=0, doc="Flat damage removed from each hit (Health.flat_armor).")
    speed: float = field(unit="m/s")
    damage: float
    range: float = field(unit="m")
    fire_interval: float = field(unit="s")
    detect: float = field(unit="m", doc="Engages inside this; advances on you outside it.")
    standoff: float = field(min=0, max=1, doc="Preferred distance as a fraction of range.")
    ride: float = field(unit="m", doc="Height of the hull's center above the ground.")
    shell_speed: float = field(unit="m/s")
    spread: float = field(unit="deg", doc="Aim error of each shell.")
    score: int
    phases: list[BossPhase] = field([])


@record
class SpawnGroup:
    tank: ContentRef[EnemyTankDef]
    count: int = field(1, min=1)


@content("wave")
class WaveDef:
    groups: list[SpawnGroup]


@content("upgrade")
class UpgradeDef:
    """A field upgrade. Every number is a delta (or a multiplier) folded into the Loadout."""

    name: Localized
    description: Localized
    icon: str
    offered: bool = field(True, doc="False for battlefield rewards that are never drawn as cards.")
    damage: float = field(0)
    max_health: float = field(0)
    pierce: float = field(0, min=0, max=1, doc="Fraction of enemy flat armor your hits ignore.")
    resist: float = field(0, min=0, max=1, doc="Fraction of incoming damage absorbed (Health.armor).")
    splash_radius: float = field(0, unit="m")
    splash_damage: float = field(0)
    repair_bonus: float = field(0)
    extra_ammo: int = field(0)
    reload_mul: float = field(1)
    speed_mul: float = field(1)
    traverse_mul: float = field(1)


@content("battlefield")
class BattlefieldDef:
    """One battlefield of the campaign."""

    name: Localized
    scene: SceneRef
    waves: list[ContentRef[WaveDef]]
    hp_mul: float
    damage_mul: float
    reward: ContentRef[UpgradeDef] | None = field(None, doc="Granted for clearing it.")
    next: ContentRef["BattlefieldDef"] | None = field(None, doc="None = the finale.")
