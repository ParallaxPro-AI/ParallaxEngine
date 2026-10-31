from parallax import Behavior, behavior, param
from project import Assets

from game.rules import Sounds
from game.actions import Controls
from game.resources import Run


@behavior("bomb_thrower")
class BombThrower(Behavior):
    """Spends a bomb: a blast that hurts every foe and breakable within reach."""

    radius: float = param(4.5, unit="m")
    damage: float = param(24)

    def update(self, ctx, dt):
        run = ctx.get(Run)
        if not ctx.input.pressed(Controls.bomb) or run.bombs == 0:
            return
        run.bombs -= 1
        at = self.entity.transform.position
        ctx.combat.area_damage(at, self.radius, self.damage, source=self.entity, falloff=False)
        ctx.vfx.play(Assets.vfx.explosion, at=at, scale=self.radius / 2.5)  # effect/explosion is tuned for a ~2.5 m blast
        ctx.audio.play(ctx.config(Sounds).bomb, at=at)
        ctx.camera.main.shake(0.35, 0.32)
