from parallax import System, on, system
from parallax.combat import Health
from project import Assets

from game.components import Guardian, Petal
from game.config import Build
from game.events import BombBloomed


@system("bombs")
class Bombs(System):
    """A petal-bloom spellcard: every hostile petal on screen bursts, and every
    guardian takes a heavy hit."""

    @on(BombBloomed)
    def bloomed(self, ctx, event: BombBloomed):
        for petal in ctx.world.query(Petal).entities():
            ctx.vfx.play(Assets.vfx.petal_burst, at=petal, scale=0.4)
            petal.destroy()
        damage = ctx.config(Build).bomb_damage
        for _, _, health in ctx.world.query(Guardian, Health):
            if not health.dead:
                health.damage(damage)
