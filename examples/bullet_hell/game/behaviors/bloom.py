import math

from parallax import Behavior, Sprite, behavior, param, vec2

from game.build import find_wisp
from game.components import Bloom, Wisp
from game.config import Arena
from game.events import BloomCollected


@behavior("bloom_drop", requires=[Bloom, Sprite])
class BloomDrop(Behavior):
    """A dropped bloom. Falls slowly, breathing; drifts toward the Wisp once Nectar
    Draw has widened the pickup radius; is collected on touch."""

    fall_speed: float = param(2.2, unit="m/s")
    draw_speed: float = param(2.4, unit="m/s")
    draw_reach: float = param(2.4, doc="Draw starts within this many pickup radii.")
    draw_beyond: float = param(0.8, unit="m", doc="Blooms drift only once the pickup radius "
                                                   "exceeds this: the stock Wisp's radius.")
    pulse: float = param(0.08, doc="Size swing as a fraction.")
    pulse_rate: float = param(8, doc="Radians per second.")

    def start(self, ctx):
        self.entity.get(Sprite).color = self.entity.get(Bloom).kind.data.color

    def update(self, ctx, dt):
        wisp = find_wisp(ctx)
        reach = wisp.get(Wisp).pickup_radius
        here = self.entity.transform.position.xy()
        to_wisp = wisp.transform.position.xy() - here
        step = vec2(0, -self.fall_speed)
        if reach > self.draw_beyond and to_wisp.length() < reach * self.draw_reach:
            step += to_wisp.normalized() * self.draw_speed
        self.entity.transform.position = here + step * dt
        self.entity.transform.scale = 1 + self.pulse * math.sin(ctx.time.now * self.pulse_rate)

        if to_wisp.length() <= reach:
            ctx.emit(BloomCollected(wisp=wisp, bloom=self.entity.get(Bloom).kind))
            self.entity.destroy()
        elif here.y < ctx.config(Arena).escape_line:
            self.entity.destroy()
