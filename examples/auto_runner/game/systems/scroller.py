"""Moves everything that scrolls."""

from parallax import System, system

from game.components import Scrolls
from game.config import Canyon
from game.events import ScrolledOff
from game.resources import Run


@system("scroller")
class Scroller(System):
    """Moves every `Scrolls` entity left at its fraction of the world speed, in
    every scene: the title's backdrop is the same canyon. Background bands wrap
    around; hazards, coins and the gate leave the screen and are destroyed
    (announcing it, so a missed coin can break the streak)."""

    def update(self, ctx, dt):
        speed = ctx.get(Run).speed
        despawn_x = ctx.config(Canyon).despawn_x
        for entity, scrolls in ctx.world.query(Scrolls):
            position = entity.transform.position
            x = position.x - speed * scrolls.factor * dt
            if scrolls.wrap_span and x < -scrolls.wrap_span / 2:
                x += scrolls.wrap_span
            elif not scrolls.wrap_span and x < despawn_x:
                ctx.emit(ScrolledOff(entity=entity))
                entity.destroy()
                continue
            entity.transform.position = position.with_x(x)
