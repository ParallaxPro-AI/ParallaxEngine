from parallax import System, system

from game.components import Drift
from game.config import Arena


@system("motion")
class Motion(System):
    """Moves every spark and petal in a straight line and clears those that leave
    the field."""

    def update(self, ctx, dt):
        arena = ctx.config(Arena)
        for entity, drift in ctx.world.query(Drift):
            position = entity.transform.position.xy() + drift.velocity * dt
            if abs(position.x) > arena.cull_half_width or abs(position.y) > arena.cull_half_height:
                entity.destroy()
            else:
                entity.transform.position = position
