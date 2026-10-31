from parallax import Behavior, TriggerEntered, behavior, on, param
from parallax.combat import Health
from parallax.physics import Rigidbody

from game.components import Shot


@behavior("cinder_shard", requires=[Shot, Rigidbody])
class CinderShardFlight(Behavior):
    """A spitter's shard: flies straight and burns the survivor on contact (its collider
    only meets the survivor)."""

    lifetime: float = param(1.6, unit="s")

    def start(self, ctx):
        self.entity.get(Rigidbody).velocity = self.entity.get(Shot).velocity
        self.entity.destroy(after=self.lifetime)

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        event.target.get(Health).damage(self.entity.get(Shot).damage, source=self.entity)
        self.entity.destroy()
