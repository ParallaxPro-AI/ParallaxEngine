from parallax import Behavior, Shape, behavior, param, vec3

from game.audio import Sounds
from features.inventory.components import Pickup
from features.inventory.holding import give
from game.world import the_player


@behavior("item_pickup", requires=[Pickup, Shape])
class ItemPickup(Behavior):
    """A dropped stack: spins in place, drifts to the player when they can see it,
    and goes into their inventory on contact if there is room."""

    magnet_range: float = param(6, unit="m")
    magnet_speed: float = param(6, unit="m/s")
    collect_range: float = param(1.5, unit="m")
    spin: float = param(90, unit="deg/s")

    def start(self, ctx):
        self.entity.get(Shape).color = self.entity.get(Pickup).stack.item.data.color

    def update(self, ctx, dt):
        tf = self.entity.transform
        tf.euler = tf.euler + vec3(0, self.spin * dt, 0)
        player = the_player(ctx)
        chest = player.transform.position + vec3(0, 0.8, 0)
        offset = chest - tf.position
        distance = offset.length()
        if distance > self.magnet_range or ctx.voxels.raycast(tf.position, offset.normalized(), distance):
            return
        stack = self.entity.get(Pickup).stack
        if distance < self.collect_range and give(player, stack.item, stack.count):
            ctx.audio.play(ctx.config(Sounds).pickup, volume=0.6)
            self.entity.destroy()
            return
        tf.position += offset.normalized() * min(distance, self.magnet_speed * dt)
