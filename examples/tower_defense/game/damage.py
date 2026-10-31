"""Damage modifiers, run by the combat plugin on every hit (see main.py)."""

from parallax import Context
from parallax.combat import DamageHit

from game.components import Poison


def venom_pierces(ctx: Context, hit: DamageHit) -> None:
    """Venom ticks go straight through armor."""
    if hit.kind == Poison:
        hit.ignores_armor = True
