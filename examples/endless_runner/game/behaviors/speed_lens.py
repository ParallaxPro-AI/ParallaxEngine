"""Widens the camera's field of view with speed."""

from parallax import Behavior, Camera, behavior, clamp, inverse_lerp, lerp, param

from game.components import Runner


@behavior("speed_lens", requires=[Camera])
class SpeedLens(Behavior):
    """Opens the field of view as the runner speeds up, so speed reads on screen."""

    slow_fov: float = param(62, unit="deg")
    fast_fov: float = param(78, unit="deg")
    slow_speed: float = param(14, unit="m/s")
    fast_speed: float = param(38, unit="m/s")

    def late_update(self, ctx, dt):
        _, runner = ctx.world.query(Runner).single()
        t = clamp(inverse_lerp(self.slow_speed, self.fast_speed, runner.speed), 0, 1)
        self.entity.get(Camera).fov = lerp(self.slow_fov, self.fast_fov, t)
