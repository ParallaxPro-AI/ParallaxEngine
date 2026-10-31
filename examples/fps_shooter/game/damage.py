"""Damage modifiers. The combat plugin runs them, in the order main.py lists them, on
every hit: bullets, grenades and test kills alike."""

from parallax import Context
from parallax.combat import DamageHit

from game.arena import current_round
from game.components import Bot, Plating, Player
from game.config import MatchRules
from game.resources import Mods


def escalation(ctx: Context, hit: DamageHit) -> None:
    """Bots hit harder as the rounds go on; upgrade cards scale what you deal and take."""
    mods = ctx.get(Mods)
    if hit.source is not None and hit.source.has(Bot):
        hit.amount *= current_round(ctx).damage_mul
    if hit.target.has(Player):
        hit.amount *= mods.damage_taken_mul
    elif hit.source is not None and hit.source.has(Player):
        hit.amount *= mods.damage_dealt_mul


def plating(ctx: Context, hit: DamageHit) -> None:
    """While the target has plating, it soaks up a share of the hit and wears down by
    what it soaked."""
    armor = hit.target.try_get(Plating)
    if armor is None or armor.points <= 0:
        return
    soaked = min(armor.points, hit.amount * ctx.config(MatchRules).armor_absorb)
    armor.points -= soaked
    hit.amount -= soaked
