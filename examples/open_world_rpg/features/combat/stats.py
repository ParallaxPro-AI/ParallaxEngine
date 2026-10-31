"""The hero's derived numbers: base curve + levels + worn gear + the merchant's upgrades."""

from parallax import Context, Tag, record

from features.combat.tags import Physical
from features.hero.feature import HeroCurve, Progression
from features.inventory.feature import Stat, upgrade_bonus, worn_pieces


@record
class HeroStats:
    damage: float
    attack_rate: float
    element: Tag
    defense: float
    max_health: float
    max_mana: float


def hero_stats(ctx: Context) -> HeroStats:
    curve = ctx.config(HeroCurve)
    growth = ctx.get(Progression).level - 1
    worn = worn_pieces(ctx)
    return HeroStats(
        damage=curve.base_damage + upgrade_bonus(ctx, Stat.DAMAGE) + sum(p.damage for p in worn),
        attack_rate=curve.base_attack_rate + upgrade_bonus(ctx, Stat.ATTACK_RATE) + sum(p.attack_rate for p in worn),
        element=next((p.element for p in worn if p.element is not None), Physical),
        defense=upgrade_bonus(ctx, Stat.DEFENSE) + sum(p.defense for p in worn),
        max_health=curve.base_health + growth * curve.health_per_level
        + upgrade_bonus(ctx, Stat.MAX_HEALTH) + sum(p.max_health for p in worn),
        max_mana=curve.base_mana + growth * curve.mana_per_level
        + upgrade_bonus(ctx, Stat.MAX_MANA) + sum(p.max_mana for p in worn),
    )
