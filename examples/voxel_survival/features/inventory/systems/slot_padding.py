from parallax import SceneLoaded, Spawned, System, on, system

from features.inventory.components import Inventory
from game.content import Stack


def pad(inventory: Inventory):
    missing = inventory.size - len(inventory.slots)
    if missing > 0:
        inventory.slots = inventory.slots + [Stack() for _ in range(missing)]


@system("slot_padding")
class SlotPadding(System):
    """Fills every inventory up to its size with empty stacks, since a prefab lists
    only the stacks it starts with: entities placed in the scene when it loads (the
    player, so the hotbar shows all nine slots) and ones spawned later (chests)."""

    @on(SceneLoaded)
    def loaded(self, ctx, event: SceneLoaded):
        for _, inventory in ctx.world.query(Inventory):
            pad(inventory)

    @on(Spawned, where=lambda event: event.entity.has(Inventory))
    def padded(self, ctx, event: Spawned):
        pad(event.entity.get(Inventory))
