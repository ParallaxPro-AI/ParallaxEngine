"""Damage modifiers, run by the combat plugin on every hit (see main.py)."""

from parallax import Context
from parallax.combat import DamageHit

from game.components import Blast, EnemyTank, PlayerTank
from game.resources import Loadout

ARMOR_FLOOR = 0.2
"""A hit always deals at least this fraction of its damage, however thick the armor."""


def tank_armor(ctx: Context, hit: DamageHit) -> None:
    """Enemy hulls shed their tier's flat armor from each shell, never below 20% of the
    hit. Your Tungsten Core pierces a fraction of it; blasts ignore it."""
    if not hit.target.has(EnemyTank) or hit.ignores_armor:
        return
    hit.ignores_armor = True
    if hit.kind is Blast:
        return
    armor = hit.target.get(EnemyTank).kind.data.armor
    if hit.source is not None and hit.source.has(PlayerTank):
        armor *= 1 - ctx.get(Loadout).pierce
    hit.amount = max(hit.amount * ARMOR_FLOOR, hit.amount - armor)
