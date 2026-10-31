from parallax import Behavior, ContentRef, behavior, param, state
from parallax.voxels import Cell3, VoxelBlock

from game.content import Block


@behavior("grows_tree", requires=[VoxelBlock], tick=1)
class GrowsTree(Behavior):
    """A sapling. Once old enough it grows into a trunk with a leafy crown, but
    only when the space above it is clear, so it never grows through a roof."""

    seconds: float = param(210, unit="s")
    trunk: ContentRef[Block] = param()
    leaves: ContentRef[Block] = param()
    trunk_height: int = param(4, min=1)
    crown_radius: int = param(2, min=1)
    age: float = state(0.0)

    def update(self, ctx, dt):
        self.age += dt
        if self.age < self.seconds:
            return
        base = self.entity.get(VoxelBlock).cell
        reach = range(-self.crown_radius, self.crown_radius + 1)
        top = self.trunk_height
        space = [base + Cell3(dx, dy, dz) for dx in reach for dz in reach for dy in range(1, top + 2)]
        if any(ctx.voxels.get(cell) for cell in space):
            return
        crown = [base + Cell3(dx, dy, dz) for dx in reach for dz in reach for dy in range(top - 1, top + 2)
                 if abs(dx) + abs(dz) + abs(dy - top) <= 2 * self.crown_radius]
        for cell in crown:
            ctx.voxels.set(cell, self.leaves)
        for dy in range(top):
            ctx.voxels.set(base + Cell3(0, dy, 0), self.trunk)
