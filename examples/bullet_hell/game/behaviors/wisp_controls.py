from parallax import Behavior, behavior, clamp, param, vec2

from game.actions import Controls
from game.components import Wisp
from game.events import BombRequested


@behavior("wisp_controls", requires=[Wisp])
class WispControls(Behavior):
    """Drifts the Wisp in every direction within the field at its build's speed.
    Holding Focus slows it for threading dense fire; Bloom asks for a bomb."""

    focus_speed: float = param(0.45, min=0, max=1, doc="Speed multiplier while focusing.")
    min_x: float = param(-4.0, unit="m")
    max_x: float = param(4.0, unit="m")
    min_y: float = param(-7.0, unit="m")
    max_y: float = param(6.5, unit="m")

    def update(self, ctx, dt):
        wisp = self.entity.get(Wisp)
        wisp.focusing = ctx.input.held(Controls.focus)
        if ctx.input.pressed(Controls.bomb):
            ctx.emit(BombRequested(wisp=self.entity))

        speed = wisp.move_speed * (self.focus_speed if wisp.focusing else 1.0)
        tf = self.entity.transform
        moved = tf.position.xy() + ctx.input.axis(Controls.move) * speed * dt
        tf.position = vec2(clamp(moved.x, self.min_x, self.max_x), clamp(moved.y, self.min_y, self.max_y))
