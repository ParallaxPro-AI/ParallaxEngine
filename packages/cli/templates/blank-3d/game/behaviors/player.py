from parallax import Behavior, behavior, clamp, param

from game.actions import Controls


@behavior("player")
class Player(Behavior):
    """Slides the entity over the ground with `Controls.move`, kept on the ground.

    `param()` fields are tunables, set per prefab in `prefabs/player.prefab.json`.
    (For walking with gravity, slopes and jumps, use the `characters()` plugin's
    `Character` component instead of moving the transform by hand.)"""

    speed: float = param(6.0, unit="m/s")
    reach: float = param(9.0, unit="m", doc="How far from the middle the player may go, on x and z.")

    def update(self, ctx, dt):
        tf = self.entity.transform
        # The stick's up (+y) becomes forward (+z) on the ground; y (height) stays put.
        target = tf.position + ctx.input.axis(Controls.move).to_ground() * self.speed * dt
        tf.position = target.with_x(clamp(target.x, -self.reach, self.reach)).with_z(clamp(target.z, -self.reach, self.reach))
