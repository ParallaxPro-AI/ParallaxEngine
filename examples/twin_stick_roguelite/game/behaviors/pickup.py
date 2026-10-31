from parallax import Behavior, Shape, TriggerEntered, behavior, on

from game.rules import Sounds
from game.components import Pickup
from game.events import ItemCollected


@behavior("pickup", requires=[Pickup, Shape])
class PickupItem(Behavior):
    """An item lying on the floor. It takes its item's shape and colour and is collected
    on touch (its collider is on the `pickup` layer, which only meets the keeper)."""

    def start(self, ctx):
        item = self.entity.get(Pickup).item.data
        shape = self.entity.get(Shape)
        shape.kind = item.mesh
        shape.color = item.color
        ctx.audio.play(ctx.config(Sounds).pickup, at=self.entity, volume=0.5)

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        ctx.emit(ItemCollected(item=self.entity.get(Pickup).item))
        self.entity.destroy()
