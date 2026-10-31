"""Where the player wakes up."""

from parallax import Context, Vec3, vec3
from parallax.voxels import Cell3


def is_open(ctx: Context, cell: Cell3) -> bool:
    block = ctx.voxels.get(cell)
    return block is None or not block.data.solid


def respawn_point(ctx: Context, home: Vec3 | None) -> Vec3:
    """Home if it's still standable, otherwise the surface at the world origin."""
    if home is not None:
        feet = ctx.voxels.cell_at(home)
        if is_open(ctx, feet) and is_open(ctx, feet + Cell3.UP):
            return home
    return vec3(0.5, ctx.voxels.surface_height(Vec3.ZERO), 0.5)
