"""The death screen's button (a panel action)."""

from parallax import Context
from parallax.characters import Character
from parallax.combat import Health

from features.survival.components import Vitals
from features.survival.home import respawn_point
from features.survival.resources import Run
from game.world import the_player


def wake_up(ctx: Context) -> None:
    """Stand back up at home, fed and breathing."""
    player = the_player(ctx)
    player.get(Health).revive()
    vitals = player.get(Vitals)
    vitals.hunger = vitals.max_hunger
    vitals.air = vitals.max_air
    player.get(Character).teleport(respawn_point(ctx, ctx.get(Run).home))
