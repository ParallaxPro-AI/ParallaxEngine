from parallax import Behavior, Shape, TriggerEntered, behavior, on, param, vec3
from project import Text

from game.rules import Sounds
from game.components import ShopItem
from game.events import ItemCollected
from game.resources import Run


@behavior("pedestal", requires=[ShopItem, Shape])
class Pedestal(Behavior):
    """A shop pedestal: walk into it with enough coins and the item is yours."""

    label_height: float = param(1.6, unit="m")

    def start(self, ctx):
        offer = self.entity.get(ShopItem)
        self.entity.get(Shape).color = offer.item.data.color
        tag = ctx.text(Text.price_tag, item=ctx.text(offer.item.data.name), price=offer.price)
        ctx.ui.label(self.entity, tag, offset=vec3(0, self.label_height, 0))

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        offer = self.entity.get(ShopItem)
        run = ctx.get(Run)
        if run.coins < offer.price:
            ctx.ui.toast(Text.need_coins, args={"price": offer.price})
            return
        run.coins -= offer.price
        ctx.audio.play(ctx.config(Sounds).buy)
        ctx.emit(ItemCollected(item=offer.item))
        self.entity.destroy()
