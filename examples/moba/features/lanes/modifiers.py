from parallax import Context
from parallax.combat import DamageHit

from game.components import Core, Tower
from game.config import MatchRules


def core_guard(ctx: Context, hit: DamageHit) -> None:
    """A combat modifier: a core takes only part of each hit while a tower of its
    team still stands within `core_guard_radius` (its two base towers). Because it
    runs inside `Health.damage`, every source of damage respects it."""
    if not hit.target.has(Core):
        return
    rules = ctx.config(MatchRules)
    guards = ctx.world.query(tagged=Tower).near(hit.target.transform.position, rules.core_guard_radius)
    if any(not ctx.combat.are_enemies(hit.target, tower) for tower in guards):
        hit.amount *= rules.core_guarded_damage
