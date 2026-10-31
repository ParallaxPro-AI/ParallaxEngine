from parallax import Behavior, behavior, on
from project import Text

from features.inventory.feature import Inventory, transact
from game.events import Used


@behavior("grave", requires=[Inventory])
class Grave(Behavior):
    """Everything you carried when you died, marked on screen (the prefab's Marker)
    until you take it back. Using it returns it all, if it all fits."""

    @on(Used)
    def used(self, ctx, event: Used):
        backpack = event.by.get(Inventory)
        recovered = transact(backpack.slots, give=[s for s in self.entity.get(Inventory).slots if s.count])
        if recovered is None:
            ctx.ui.toast(Text.make_room_for_belongings)
            return
        backpack.slots = recovered
        ctx.ui.toast(Text.belongings_recovered)
        self.entity.destroy()
