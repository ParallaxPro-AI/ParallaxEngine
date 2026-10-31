from parallax import System, system
from parallax.combat import Health
from project import Placed

from game.components import Fighter
from game.resources import Mode
from game.rules import Rules, in_mode


@system("practice", when=in_mode(Mode.PRACTICE))
class Practice(System):
    """Practice: no clock, the challenger's SPIRIT stays full, and the dummy heals each
    time it recovers. The HUD's dummy buttons are `choose_dummy` (game/menu_actions.py)."""

    def update(self, ctx, dt):
        ctx.world.placed(Placed.challenger).get(Fighter).meter = ctx.config(Rules).meter_max
        dummy = ctx.world.placed(Placed.rival)
        health = dummy.get(Health)
        if dummy.get(Fighter).stun_left == 0 and health.current < health.max:
            health.heal(health.max)
