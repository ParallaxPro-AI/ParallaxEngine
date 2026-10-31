from parallax import Behavior, behavior, param
from parallax.characters import Character
from parallax.combat import Health

from game.actions import Controls
from game.components import Build


@behavior("dash", requires=[Character, Health, Build])
class Dash(Behavior):
    """A short burst in the move direction that nothing can touch, on one charge that
    recharges in `cooldown` seconds (kept on `Build` so the HUD's dash row shows it)."""

    speed: float = param(22, unit="m/s")
    untouchable: float = param(0.35, unit="s")
    cooldown: float = param(1.6, unit="s")

    def update(self, ctx, dt):
        build = self.entity.get(Build)
        if ctx.time.now < build.dash_ready_at or not ctx.input.pressed(Controls.dash):
            return
        build.dash_ready_at = ctx.time.now + self.cooldown
        build.dash_cooldown = self.cooldown
        stick = ctx.input.axis(Controls.move)
        direction = ctx.camera.main.relative(stick) if stick.length() > 0 else self.entity.transform.forward
        self.entity.get(Character).knockback(direction.normalized() * self.speed)
        self.entity.get(Health).protect(self.untouchable)
