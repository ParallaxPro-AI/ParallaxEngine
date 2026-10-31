from parallax import Behavior, TriggerEntered, behavior, on, param, vec3
from parallax.combat import Health
from project import Assets

from game.rules import Rules, play


@behavior("ember_heart")
class EmberHeart(Behavior):
    """A heal that won't come to you: walk to it before it rots."""

    lifetime: float = param(16, unit="s")

    def start(self, ctx):
        self.entity.destroy(after=self.lifetime)

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        health = event.target.get(Health)
        health.heal(health.max * ctx.config(Rules).heart_heal_pct)
        ctx.vfx.play(Assets.vfx.heart_magic, at=self.entity.transform.position + vec3(0, 1.2, 0))
        play(ctx, ctx.config(Rules).sounds.heart)
        self.entity.destroy()
