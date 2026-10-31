import math

from parallax import Behavior, Color, Sprite, behavior, param
from parallax.combat import Health

from game.components import Wisp


@behavior("wisp_glow", requires=[Wisp, Health, Sprite])
class WispGlow(Behavior):
    """Shows the Wisp's state on its body: tinted while a dewshield is up, blinking
    while invulnerable, and the focus ring (a prefab child the exact size of the
    hitbox) shown only while focusing."""

    shield_color: Color = param(Color.hex("#8cffbf"))
    blink_rate: float = param(22, doc="Radians per second of the blink wave.")
    blink_low: float = param(0.35, min=0, max=1)

    def update(self, ctx, dt):
        health = self.entity.get(Health)
        color = self.shield_color if health.shield > 0 else Color.WHITE
        if health.invulnerable:
            wave = abs(math.sin(ctx.time.now * self.blink_rate))
            color = color.with_alpha(self.blink_low + (1 - self.blink_low) * wave)
        self.entity.get(Sprite).color = color
        self.entity.child("focus_ring").visible = self.entity.get(Wisp).focusing
