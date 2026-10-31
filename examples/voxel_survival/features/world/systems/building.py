from parallax import Entity, System, on, system
from parallax.voxels import Cell3
from project import Assets, Text

from features.inventory.feature import Furnace, Inventory, LootDropped, is_empty, selected, spend_selected
from features.world.events import BreakRequested, PlaceRequested
from features.world.placement import placement_problem
from game.content import roll


@system("building")
class Building(System):
    """Applies the player's block requests to the world. Breaking drops the block's
    loot; placing spends the selected item. Two-block pieces (doors) move together,
    and a station still holding items can't be picked up. Only the block the player
    acted on carries a `source`, so `BlockChanged` listeners count one edit per action."""

    @on(BreakRequested)
    def broke(self, ctx, event: BreakRequested):
        cell = event.cell
        block = ctx.voxels.get(cell)
        if block.data.is_upper:
            cell = cell + Cell3.DOWN
            block = ctx.voxels.get(cell)
        if block.data.unbreakable:
            return
        holder = ctx.voxels.block_entity(cell)
        if holder and _holds_items(holder):
            ctx.ui.toast(Text.empty_station_first)
            return
        ctx.voxels.set(cell, None, by=event.by)
        if block.data.upper:
            ctx.voxels.set(cell + Cell3.UP, None)
        ctx.audio.play(block.data.sound, at=cell.center())
        ctx.vfx.play(Assets.vfx.block_dust, at=cell.center())
        ctx.emit(LootDropped(stacks=roll(block.data.loot), at=cell.center()))

    @on(PlaceRequested)
    def placed(self, ctx, event: PlaceRequested):
        item = selected(event.by).item
        block = item.data.places if item else None
        if block is None:
            ctx.ui.toast(Text.select_block)
            return
        problem = placement_problem(ctx, block, event.cell, event.by)
        if problem:
            ctx.ui.toast(problem)
            return
        spend_selected(event.by)
        ctx.voxels.set(event.cell, block, by=event.by)
        if block.data.upper:
            ctx.voxels.set(event.cell + Cell3.UP, block.data.upper)
        ctx.audio.play(block.data.sound, at=event.cell.center())


def _holds_items(holder: Entity) -> bool:
    inventory = holder.try_get(Inventory)
    furnace = holder.try_get(Furnace)
    return bool((inventory and not is_empty(inventory.slots)) or (furnace and furnace.output.count))
