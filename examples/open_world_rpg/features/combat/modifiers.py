"""Damage modifiers, installed on the combat plugin in game/main.py so every hit goes through them."""

from parallax import Context
from parallax.combat import DamageHit

from features.combat.components import Affinity
from features.combat.events import WeaknessFound


def weakness(ctx: Context, hit: DamageHit) -> None:
    """Scales a hit by the target's affinity for its damage kind, and tells the attacker when it mattered."""
    affinity = hit.target.try_get(Affinity)
    if affinity is None or hit.kind is None:
        return
    multiplier = affinity.multipliers.get(hit.kind, 1.0)
    if multiplier == 1.0:
        return
    hit.amount *= multiplier
    if hit.source is not None:
        effect = "weak" if multiplier > 1 else "resisted"
        ctx.emit(WeaknessFound(attacker=hit.source, kind=hit.kind, effect=effect, multiplier=multiplier))
