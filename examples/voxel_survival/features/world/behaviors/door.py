from parallax import Behavior, ContentRef, behavior, on, param
from parallax.voxels import Cell3, VoxelBlock
from project import Text

from features.world.placement import blocks_body
from game.content import Block
from game.events import Used


@behavior("door", requires=[VoxelBlock])
class Door(Behavior):
    """Swaps this door for its open or closed twin when used. A door won't close
    on whoever is standing in the doorway."""

    swaps_to: ContentRef[Block] = param(doc="The block this door becomes when used.")

    @on(Used)
    def used(self, ctx, event: Used):
        cell = self.entity.get(VoxelBlock).cell
        twin = self.swaps_to.data
        if twin.solid and (blocks_body(event.by, cell) or blocks_body(event.by, cell + Cell3.UP)):
            ctx.ui.toast(Text.step_clear)
            return
        ctx.voxels.set(cell, self.swaps_to)
        ctx.voxels.set(cell + Cell3.UP, twin.upper)
        ctx.audio.play(twin.sound, at=cell.center())
