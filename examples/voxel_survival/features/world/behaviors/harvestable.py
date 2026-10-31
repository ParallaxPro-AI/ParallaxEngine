from parallax import Behavior, ContentRef, behavior, on, param
from parallax.voxels import VoxelBlock
from project import Text

from features.inventory.feature import give
from features.world.events import Harvested
from game.content import Block, ItemDef
from game.events import Used


@behavior("harvestable", requires=[VoxelBlock])
class Harvestable(Behavior):
    """A ripe crop: using it puts the yield in the backpack and replants."""

    yields: ContentRef[ItemDef] = param()
    count: int = param(3, min=1)
    replant_as: ContentRef[Block] = param()

    @on(Used)
    def used(self, ctx, event: Used):
        if not give(event.by, self.yields, self.count):
            ctx.ui.toast(Text.backpack_full)
            return
        ctx.voxels.set(self.entity.get(VoxelBlock).cell, self.replant_as)
        ctx.ui.toast(Text.harvested)
        ctx.emit(Harvested(by=event.by))
