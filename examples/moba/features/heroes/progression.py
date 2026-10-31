from parallax import Context, Entity

from features.heroes.components import Progression
from features.heroes.events import LeveledUp
from game.config import MatchRules
from game.content import AbilityDef


def xp_to_next(ctx: Context, level: int) -> float:
    rules = ctx.config(MatchRules)
    return rules.xp_base + rules.xp_per_level * level


def grant_xp(ctx: Context, hero: Entity, amount: float) -> None:
    """Add XP, leveling up (and earning skill points) as many times as it pays for."""
    p = hero.get(Progression)
    max_level = ctx.config(MatchRules).max_level
    if p.level >= max_level:
        return
    p.xp += amount
    while p.level < max_level and p.xp >= xp_to_next(ctx, p.level):
        p.xp -= xp_to_next(ctx, p.level)
        p.level += 1
        p.skill_points += 1
        ctx.emit(LeveledUp(hero=hero, level=p.level))


def rank_cap(ctx: Context, ability: AbilityDef, level: int) -> int:
    """How many ranks of `ability` a champion of `level` may have."""
    rules = ctx.config(MatchRules)
    unlocks = rules.ultimate_rank_levels if ability.ultimate else rules.basic_rank_levels
    return min(ability.max_rank, sum(1 for at in unlocks if at <= level))
