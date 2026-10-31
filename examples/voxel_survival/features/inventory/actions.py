"""The inventory panels' buttons. Each is a panel action: its typed parameters are
filled from the clicked element (`recipe` and `slot` from the list item)."""

from parallax import ContentRef, Context, Entity
from project import Text

from game.audio import Sounds
from features.inventory.components import Equipment, Furnace, Hotbar, Inventory
from features.inventory.events import ItemCrafted, ItemStored
from features.inventory.holding import give
from features.inventory.recipes import idle_furnace, lock_reason
from features.inventory.resources import OpenStation
from features.inventory.stacks import transact
from game.content import RecipeDef, Stack
from game.world import the_player


def craft(ctx: Context, recipe: ContentRef[RecipeDef]) -> None:
    """Make `recipe` as one inventory transaction. Hand recipes work anywhere,
    workbench recipes near a workbench, and timed recipes load the nearest idle
    furnace instead of finishing at once."""
    player = the_player(ctx)
    made = recipe.data
    reason = lock_reason(ctx, made, player)
    if reason:
        ctx.ui.toast(reason)
        return
    inventory = player.get(Inventory)
    if made.seconds > 0:
        furnace = idle_furnace(ctx, player.transform.position).get(Furnace)
        inventory.slots = transact(inventory.slots, take=made.inputs)
        furnace.output = made.output
        furnace.seconds_left = made.seconds
        ctx.ui.toast(Text.furnace_lit)
        return
    crafted = transact(inventory.slots, take=made.inputs, give=[made.output])
    if crafted is None:
        ctx.ui.toast(Text.backpack_full)
        return
    inventory.slots = crafted
    item = made.output.item
    if item.data.tool:
        player.get(Equipment).tool = item
    ctx.audio.play(ctx.config(Sounds).craft)
    ctx.ui.toast(ctx.text(Text.crafted, item=ctx.text(made.name)))
    ctx.emit(ItemCrafted(item=item, by=player))


def use_slot(ctx: Context, slot: int) -> None:
    """A backpack or hotbar slot clicked: a tool is equipped, a hotbar slot is
    selected, and a backpack stack swaps into the selected hotbar slot."""
    player = the_player(ctx)
    slots = player.get(Inventory).slots
    hotbar = player.get(Hotbar)
    stack = slots[slot]
    if stack.item and stack.item.data.tool:
        player.get(Equipment).tool = stack.item
        ctx.ui.toast(ctx.text(Text.equipped, item=ctx.text(stack.item.data.name)))
    elif slot >= hotbar.size:
        swapped = list(slots)
        swapped[hotbar.selected], swapped[slot] = slots[slot], slots[hotbar.selected]
        player.get(Inventory).slots = swapped
    else:
        hotbar.selected = slot


def store(ctx: Context, slot: int) -> None:
    """Chest panel: move a backpack stack into the chest."""
    moved = _move(ctx, the_player(ctx), slot, ctx.get(OpenStation).station)
    if moved is not None:
        ctx.emit(ItemStored(item=moved.item))


def take(ctx: Context, slot: int) -> None:
    """Chest panel: move a chest stack into the backpack."""
    _move(ctx, ctx.get(OpenStation).station, slot, the_player(ctx))


def collect(ctx: Context) -> None:
    """Furnace panel: put the finished output in the backpack."""
    furnace = ctx.get(OpenStation).station.get(Furnace)
    if furnace.seconds_left > 0 or furnace.output.count == 0:
        return
    if not give(the_player(ctx), furnace.output.item, furnace.output.count):
        ctx.ui.toast(Text.backpack_full)
        return
    furnace.output = Stack()
    ctx.audio.play(ctx.config(Sounds).pickup)


def leave_station(ctx: Context) -> None:
    """Close the chest or furnace panel, which follows `OpenStation`."""
    ctx.get(OpenStation).station = None


def _move(ctx: Context, source: Entity, index: int, target: Entity) -> Stack | None:
    """Move one whole stack between two inventories. Returns the stack moved, or
    None if the slot was empty or the stack doesn't fit."""
    stack = source.get(Inventory).slots[index]
    if stack.count == 0:
        return None
    received = transact(target.get(Inventory).slots, give=[stack])
    if received is None:
        ctx.ui.toast(Text.no_room_for_stack)
        return None
    target.get(Inventory).slots = received
    emptied = list(source.get(Inventory).slots)
    emptied[index] = Stack()
    source.get(Inventory).slots = emptied
    return stack
