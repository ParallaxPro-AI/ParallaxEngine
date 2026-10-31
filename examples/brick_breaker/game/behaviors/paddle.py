from parallax import Behavior, behavior, clamp, param

from game.actions import Controls
from game.resources import Mods


@behavior("paddle_control")
class PaddleControl(Behavior):
    """Slides the paddle between the rails with the steer action (or the touch Left /
    Right plates), or follows the mouse or a finger across the board, whichever moved
    last. Upgrades widen it and speed it up."""

    speed: float = param(14.0, unit="m/s")
    half_width: float = param(1.2, unit="m")
    rail_x: float = param(9.0, unit="m", doc="Inner edge of the side rails.")

    def update(self, ctx, dt):
        mods = ctx.get(Mods)
        tf = self.entity.transform
        tf.scale = tf.scale.with_x(mods.paddle_width)

        steer = ctx.input.value(Controls.steer)
        if ctx.input.held(Controls.steer_left):
            steer = -1.0
        elif ctx.input.held(Controls.steer_right):
            steer = 1.0
        pointer = ctx.input.pointer
        if steer:
            x = tf.position.x + steer * self.speed * mods.paddle_speed * dt
        elif pointer.moved:
            x = pointer.world.x
        else:
            return
        limit = self.rail_x - self.half_width * mods.paddle_width
        tf.position = tf.position.with_x(clamp(x, -limit, limit))
