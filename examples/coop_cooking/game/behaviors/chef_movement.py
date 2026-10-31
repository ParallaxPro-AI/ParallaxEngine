from parallax import Behavior, behavior
from parallax.characters import Character

from game.actions import ChefControls


@behavior("chef_movement", requires=[Character])
class ChefMovement(Behavior):
    """Walks the chef with their seat's move stick, relative to their seat's camera.

    Written exactly like a single-player behavior: `ctx.input` and `ctx.camera.main`
    are this seat's."""

    def update(self, ctx, dt):
        stick = ctx.input.axis(ChefControls.move)
        self.entity.get(Character).move(ctx.camera.main.relative(stick))
