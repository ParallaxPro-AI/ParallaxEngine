from parallax import Behavior, behavior

from game.config import Rules
from game.resources import in_play


@behavior("rock", when=in_play)
class Falling(Behavior):
    """Falls at the configured speed and removes itself below the floor."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        tf = self.entity.transform
        tf.position = tf.position.with_y(tf.position.y - rules.fall_speed * dt)
        if tf.position.y < rules.floor:
            self.entity.destroy()
