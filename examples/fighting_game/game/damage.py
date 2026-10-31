"""Damage modifiers, run by the combat plugin on every hit (see game/main.py)."""

from parallax import Context
from parallax.combat import DamageHit

from game.components import Rival
from game.resources import Match, Mode
from game.rules import difficulty


def rival_difficulty(ctx: Context, hit: DamageHit) -> None:
    """The difficulty setting scales the rival's damage."""
    if hit.source is not None and hit.source.has(Rival):
        hit.amount *= difficulty(ctx).damage_scale


def only_the_circuit_knocks_out(ctx: Context, hit: DamageHit) -> None:
    """Training and practice wear fighters down to 1 but never finish them."""
    if ctx.get(Match).mode is not Mode.CIRCUIT:
        hit.lethal = False
