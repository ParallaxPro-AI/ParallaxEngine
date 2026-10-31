from parallax import System, system

from game.components import Effort, Stamina
from game.resources import Match, playing


@system("fatigue", when=playing)
class Fatigue(System):
    """Sprinting empties the tank of the player you control; an empty tank leaves
    them jogging until it refills past its floor. Everyone you are NOT controlling
    recovers at the resting rate, which is the reason to switch players."""

    def update(self, ctx, dt):
        controlled = ctx.get(Match).controlled
        for player, stamina in ctx.world.query(Stamina):
            effort = stamina.effort if player == controlled else Effort.REST
            if effort is Effort.SPRINT:
                stamina.current = max(0.0, stamina.current - stamina.drain * dt)
                stamina.blown = stamina.blown or stamina.current == 0
                continue
            regen = stamina.rest_regen if effort is Effort.REST else stamina.regen
            stamina.current = min(stamina.max, stamina.current + regen * dt)
            if stamina.current > stamina.floor:
                stamina.blown = False
