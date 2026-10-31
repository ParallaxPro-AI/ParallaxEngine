from parallax import Behavior, behavior, clamp, param

from game.actions import Controls
from game.resources import in_play


@behavior("player", when=in_play)
class Player(Behavior):
    """Slides the player left and right along the bottom of the screen. Stops
    once the run is over (`when=in_play`).

    `param()` fields are tunables, set per prefab in `prefabs/player.prefab.json`."""

    speed: float = param(8.0, unit="m/s")
    reach: float = param(4.5, unit="m", doc="How far from the middle the player may go.")

    def update(self, ctx, dt):
        tf = self.entity.transform
        x = tf.position.x + ctx.input.value(Controls.move) * self.speed * dt
        tf.position = tf.position.with_x(clamp(x, -self.reach, self.reach))
