"""Content registries: towers, enemies, waves and battlefields. Status effects (chill,
venom) are the combat plugin's built-in `status_effect` kind."""

from enum import Enum

from parallax import (
    Color, ContentRef, EffectRef, Localized, ModelRef, PrefabRef, SceneRef, SoundRef, content, field, record,
)
from parallax.combat import StatusEffectDef


class Attack(Enum):
    SINGLE = "single"
    SPLASH = "splash"
    CHAIN = "chain"


@record
class TowerLevel:
    """Everything a tower is at one level. Level 1 is the build; later levels are upgrades."""

    cost: int
    damage: float
    range: float = field(unit="m")
    fire_interval: float = field(unit="s")
    model: ModelRef
    splash_radius: float = field(0, unit="m")
    chain_count: int = field(1)
    chain_range: float = field(0, unit="m")
    chain_falloff: float = field(1)
    effect: ContentRef[StatusEffectDef] | None = field(None, doc="Applied to everything the shot strikes.")
    effect_strength: float = field(1, doc="The dose: share of speed taken (chill), damage per second (venom).")
    effect_seconds: float = field(0, unit="s")


@content("tower", order="slot")
class TowerDef:
    """A tower in the build palette."""

    name: Localized
    role: Localized = field(doc="One word for what it does on its palette card (Precise, Splash).")
    accent: str = field(doc="CSS colour of its palette card.")
    slot: int = field(min=1, doc="Palette position and hotkey.")
    prefab: PrefabRef
    attack: Attack
    shot: PrefabRef = field(doc="Projectile prefab (its shot_flight params set speed and arc).")
    impact: EffectRef
    fire_sound: SoundRef
    levels: list[TowerLevel]


@content("enemy")
class EnemyDef:
    """An invader. Battlefields scale health, speed and armor (see LevelDef)."""

    name: Localized
    prefab: PrefabRef
    health: float = field(min=1)
    speed: float = field(unit="m/s")
    armor: float = field(min=0, doc="Flat damage removed from every hit (Health.flat_armor).")
    resists: dict[ContentRef[StatusEffectDef], float] = field({}, doc="Share of an effect's dose shrugged off (1 = immune).")
    reward: int = field(min=0, doc="Gold for a kill, before the battlefield's bounty multiplier.")
    lives_cost: int = field(min=1, doc="Lives lost if it reaches the keep.")


@record
class SpawnGroup:
    enemy: ContentRef[EnemyDef]
    count: int = field(1, min=1)


@content("wave")
class WaveDef:
    announce: Localized
    groups: list[SpawnGroup]
    boss: bool = field(False)


@content("level", order="number")
class LevelDef:
    """A battlefield: its scene, its purse, how much tougher its enemies are, its waves."""

    number: int = field(min=1, doc="Position on the battlefield map.")
    name: Localized
    tagline: Localized = field(doc="One line under its name on the campaign card.")
    land: Color = field(doc="The campaign card's map colour.")
    scene: SceneRef
    start_gold: int
    start_lives: int
    hp_mul: float
    speed_mul: float
    armor_add: float
    bounty_mul: float
    waves: list[ContentRef[WaveDef]]
    unlocked_by: ContentRef["LevelDef"] | None = field(None, doc="Clear this battlefield first.")
