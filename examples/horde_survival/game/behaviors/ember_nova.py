from parallax import Behavior, behavior

from game.actions import Controls
from game.blast import blast
from game.components import Build
from game.rules import Rules, play


@behavior("ember_nova", requires=[Build])
class EmberNova(Behavior):
    """The one button: a shockwave on a cooldown that clears breathing room."""

    def update(self, ctx, dt):
        build = self.entity.get(Build)
        if ctx.time.now >= build.nova_ready_at and ctx.input.pressed(Controls.nova):
            build.nova_ready_at = ctx.time.now + build.nova_cooldown
            blast(ctx, self.entity, build.nova_radius, build.nova_damage)
            ctx.camera.main.shake(0.55, 0.32)
            play(ctx, ctx.config(Rules).sounds.nova)
