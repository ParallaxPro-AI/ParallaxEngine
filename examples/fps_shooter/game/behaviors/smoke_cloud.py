from parallax import Behavior, behavior

from game.components import SmokeCloud


@behavior("smoke_cloud", requires=[SmokeCloud])
class SmokeCloudLife(Behavior):
    """A smoke cloud stops blocking sight when it clears, and is removed."""

    def update(self, ctx, dt):
        if ctx.time.now >= self.entity.get(SmokeCloud).clears_at:
            self.entity.destroy()
