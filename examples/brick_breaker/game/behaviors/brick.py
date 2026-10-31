from parallax import Behavior, Color, Shape, behavior, clamp, on, param
from parallax.combat import Damaged, Died, Health
from project import Assets

from game.audio import Sounds, play
from game.progress import current_stage, lit


@behavior("prism_brick", requires=[Health, Shape])
class PrismBrick(Behavior):
    """Shades the brick in the stage colour, darker for every hit point it has left,
    and cracks and shatters with sparks."""

    brightness: float = param(1.15, doc="Brightness of a brick with zero hit points.")
    darken_per_hit_point: float = param(0.22)

    def start(self, ctx):
        self.shade(ctx)

    @on(Damaged)
    def cracked(self, ctx, event: Damaged):
        self.shade(ctx)
        play(ctx, ctx.config(Sounds).brick)
        if self.entity.get(Health).current > 0:  # the lethal hit shatters instead (shattered)
            ctx.vfx.play(Assets.vfx.sparks, at=self.entity, color=current_stage(ctx).color, count=5)

    @on(Died)
    def shattered(self, ctx, event: Died):
        ctx.vfx.play(Assets.vfx.shatter_sparks, at=self.entity, color=current_stage(ctx).color)

    def shade(self, ctx):
        hit_points = self.entity.get(Health).current
        light = clamp(self.brightness - self.darken_per_hit_point * hit_points, 0.4, 1.1)
        self.entity.get(Shape).color = lit(current_stage(ctx).color, light)
