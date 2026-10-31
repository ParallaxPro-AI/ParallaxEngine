import random

from parallax import System, on, system, vec3
from project import Prefabs

from features.inventory.components import Pickup
from features.inventory.events import LootDropped
from game.content import Stack


@system("loot")
class Loot(System):
    """Puts dropped stacks into the world as pickups, topping up a matching pickup
    lying close by instead of scattering a pile of single items."""

    @on(LootDropped)
    def dropped(self, ctx, event: LootDropped):
        for stack in event.stacks:
            nearby = (ctx.world.query(Pickup)
                      .near(event.at, 3)
                      .where(lambda _, held: held.stack.item == stack.item
                             and held.stack.count + stack.count <= stack.item.data.stack_max)
                      .first())
            if nearby:
                _, pickup = nearby
                pickup.stack = Stack(stack.item, pickup.stack.count + stack.count)
                continue
            jitter = vec3(random.uniform(-0.2, 0.2), 0, random.uniform(-0.2, 0.2))
            ctx.world.spawn(Prefabs.item_drop, at=event.at + jitter, components=[Pickup(stack=stack)])
