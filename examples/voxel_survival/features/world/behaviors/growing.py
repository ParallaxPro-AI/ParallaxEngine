from parallax import Behavior, ContentRef, behavior, param, state
from parallax.voxels import VoxelBlock

from game.content import Block


@behavior("growing", requires=[VoxelBlock], tick=1)
class Growing(Behavior):
    """Turns its block into the next growth stage after `seconds`."""

    seconds: float = param(150, unit="s")
    becomes: ContentRef[Block] = param()
    age: float = state(0.0)

    def update(self, ctx, dt):
        self.age += dt
        if self.age >= self.seconds:
            ctx.voxels.set(self.entity.get(VoxelBlock).cell, self.becomes)
