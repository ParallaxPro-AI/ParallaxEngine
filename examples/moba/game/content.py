"""Content registries: champions, abilities, shop items, lane units, jungle camps,
lanes and factions.

A champion is one file naming its model, base stats, passive and four ability
files. An ability is one file: a `kind` that says what it does, and numbers that
grow with rank. Adding a champion is five or six JSON files and no code.
"""

from enum import Enum

from parallax import (
    ClipRef, Color, ContentRef, EffectRef, Localized, ModelRef, PrefabRef, Tag, Vec2, content, field, record,
)
from parallax.combat import StatusEffectDef


@record
class StatBlock:
    """A bundle of stat values as content writes them: base stats, passives, items,
    buffs and jungle rewards. `features/fighting/stats.py` turns one into a unit's
    base numbers or into stat modifiers."""
    max_health: float = field(0)
    max_mana: float = field(0)
    mana_regen: float = field(0)
    damage: float = field(0)
    ability_power: float = field(0)
    attack_range: float = field(0, unit="m")
    attack_interval: float = field(0, unit="s")
    move_speed: float = field(0, unit="m/s")
    damage_reduction: float = field(0, doc="Fraction of each hit absorbed (Health.armor).")
    dash_bonus: float = field(0, unit="m")

    def __add__(self, other: "StatBlock") -> "StatBlock":
        return StatBlock(
            max_health=self.max_health + other.max_health,
            max_mana=self.max_mana + other.max_mana,
            mana_regen=self.mana_regen + other.mana_regen,
            damage=self.damage + other.damage,
            ability_power=self.ability_power + other.ability_power,
            attack_range=self.attack_range + other.attack_range,
            attack_interval=self.attack_interval + other.attack_interval,
            move_speed=self.move_speed + other.move_speed,
            damage_reduction=self.damage_reduction + other.damage_reduction,
            dash_bonus=self.dash_bonus + other.dash_bonus,
        )


@record
class Ranked:
    """A number that grows with rank: `base` at rank 1, plus `per_rank` per rank after."""
    base: float = field(0)
    per_rank: float = field(0)

    def at(self, rank: int) -> float:
        return self.base + self.per_rank * (rank - 1)


@record
class Clips:
    """Animation clips by purpose."""
    idle: ClipRef | None = field(None)
    run: ClipRef | None = field(None)
    attack: ClipRef | None = field(None)
    cast: ClipRef | None = field(None)
    recall: ClipRef | None = field(None)
    death: ClipRef | None = field(None)


class AbilityKind(Enum):
    MELEE = "melee"
    """A frontal cleave in front of the caster."""
    SKILLSHOT = "skillshot"
    """A line toward the aim point; misses what it misses."""
    GROUND = "ground"
    """A circle at the aim point."""
    HEAL = "heal"
    SHIELD = "shield"
    """A shield that expires after `duration`."""
    BUFF = "buff"
    """Temporary stats on the caster."""
    DASH = "dash"
    """Move fast toward (or away from) the aim; may detonate on landing."""


class CastAnimation(Enum):
    CAST = "cast"
    ATTACK = "attack"


class ItemCategory(Enum):
    ATTACK = "attack"
    ARCANE = "arcane"
    GUARD = "guard"
    SWIFT = "swift"
    RELIC = "relic"


@content("ability")
class AbilityDef:
    name: Localized
    blurb: Localized
    kind: AbilityKind = field()
    max_rank: int = field(5, min=1)
    ultimate: bool = field(False, doc="Ranks unlock at the ultimate levels instead of the basic ones.")
    cooldown: Ranked = field(unit="s")
    mana: Ranked = field()
    damage: Ranked = field(Ranked())
    damage_kind: Tag | None = field(None)
    range: Ranked = field(Ranked(), unit="m")
    radius: Ranked = field(Ranked(), unit="m")
    width: float = field(1.4, unit="m", doc="Skillshot hitbox width.")
    heal: Ranked = field(Ranked())
    shield: Ranked = field(Ranked())
    duration: Ranked = field(Ranked(), unit="s")
    buff: StatBlock = field(StatBlock())
    effect: ContentRef[StatusEffectDef] | None = field(None, doc="Applied to every unit hit (slows).")
    effect_seconds: float = field(0, unit="s")
    dash: Ranked = field(Ranked(), unit="m")
    dash_seconds: float = field(0.2, unit="s")
    dash_away: bool = field(False)
    trail: Color | None = field(None, doc="Dashes: a glowing ribbon of this colour behind the caster.")
    cast_time: float = field(0, unit="s", doc="Delay between the cast and the effect.")
    animation: CastAnimation = field(CastAnimation.CAST)
    cast_vfx: EffectRef | None = field(None, doc="Played on the caster as the ability goes off (melee, skillshot, ground, buff).")
    vfx: EffectRef = field(doc="Played on every unit hit, where a dash lands, or on the caster for heals, shields and buffs.")


@content("champion")
class ChampionDef:
    name: Localized
    role: Localized
    passive_name: Localized
    model: ModelRef = field()
    scale: float = field(1)
    color: Color = field(doc="Draft board swatch.")
    crest: str = field(doc="The portrait mark: an SVG path in a 40x46 box (the HUD dock).")
    role_icon: str = field(doc="The class glyph on the draft board: swords, spark, bow, venom or aegis.")
    clips: Clips = field()
    bolt: EffectRef | None = field(None, doc="Shown where a basic attack lands.")
    stats: StatBlock = field()
    passive: StatBlock = field()
    abilities: list[ContentRef[AbilityDef]] = field(doc="Q, W, E, R.")


@content("item")
class ItemDef:
    name: Localized
    blurb: Localized
    icon: str = field()
    category: ItemCategory = field()
    tier: int = field(1)
    cost: int = field(min=0)
    stats: StatBlock = field()
    builds_from: list[ContentRef["ItemDef"]] = field([], doc="Owned components are consumed and credited.")


@content("unit")
class UnitDef:
    """A lane minion role. Teams differ only by prefab (see FactionDef)."""
    scale: float = field(1)
    rank: int = field(0, doc="Formation row: 0 front, 2 back.")
    bolt: EffectRef | None = field(None)
    clips: Clips = field(Clips())
    stats: StatBlock = field()
    gold: int = field(0)
    xp: float = field(0)


@content("camp")
class CampDef:
    taken: Localized | None = field(None, doc="Announced (with {champion}) when a champion takes the reward.")
    stats: StatBlock = field()
    gold: int = field(0)
    xp: float = field(0)
    respawn: float = field(unit="s")
    reward: StatBlock = field(StatBlock(), doc="Permanent stats for the champion who takes it.")


@content("lane")
class LaneDef:
    path: list[Vec2] = field(doc="Waypoints (x, z) from the blue core to the red core.")


@content("faction", order="seat")
class FactionDef:
    name: Localized
    seat: int = field(doc="The player seat that plays this faction.")
    side: Tag = field()
    minion: PrefabRef = field()
    walks_lanes_backwards: bool = field(False)
    map_color: Color = field(doc="This side's units on the minimap.")


@record
class WaveMix:
    from_wave: int = field(min=1)
    units: list[ContentRef[UnitDef]] = field()
