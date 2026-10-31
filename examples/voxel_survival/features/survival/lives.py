"""The two facts the death and game-over screens follow."""

from parallax import Context
from parallax.combat import Health

from features.survival.resources import Run
from game.config import Rules
from project import Placed, Scenes


def player_down(ctx: Context) -> bool:
    """The player has died and not yet woken up."""
    if not ctx.scenes.current_is(Scenes.greenwood):
        return False
    player = ctx.world.placement(Placed.player).loaded
    return player is not None and player.get(Health).dead


def run_over(ctx: Context) -> bool:
    """A challenge run that has used up its lives."""
    run = ctx.get(Run)
    return run.challenge and run.deaths >= ctx.config(Rules).lives
