from parallax import Behavior, behavior
from parallax.characters import Character

from game.actions import Controls
from game.resources import Run


@behavior("keeper_movement", requires=[Character])
class KeeperMovement(Behavior):
    """Walks the keeper relative to the camera at the run's current move speed."""

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        body.walk_speed = ctx.get(Run).move_speed
        body.move(ctx.camera.main.relative(ctx.input.axis(Controls.move)))
